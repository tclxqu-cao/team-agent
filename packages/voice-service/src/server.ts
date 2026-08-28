import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AsrResultEvent, AsrSession } from "./asr-engine.js";
import type { KwsResultEvent, KwsSession } from "./kws-engine.js";
import type { TtsPcmStream } from "./mlx-tts-engine.js";
import {
  parseAsrControl,
  parseTtsRequest,
  parseTtsStreamControl,
  type TtsRequest,
} from "./protocol.js";
import { TtsOverloadedError } from "./tts-engine.js";
import { encodePcm16Wav } from "./wav.js";

export interface AsrEngineLike {
  createSession(
    sessionId: string,
    generation: number,
    emit: (event: AsrResultEvent) => void,
  ): AsrSession;
}

export interface KwsEngineLike {
  createSession(
    sessionId: string,
    generation: number,
    emit: (event: KwsResultEvent) => void,
  ): KwsSession;
}

export interface TtsEngineLike {
  generate?(
    request: TtsRequest,
    signal: AbortSignal,
  ): Promise<{ wav: Buffer; sampleRate: number }>;
  stream?(request: TtsRequest, signal: AbortSignal): Promise<TtsPcmStream>;
}

export interface TtsRuntimeState {
  engine?: TtsEngineLike;
  loading: boolean;
  error: string | null;
  ready?: Promise<void>;
}

export interface VoiceServer {
  httpUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

interface VoiceServerOptions {
  host: string;
  port: number;
  token: string | null;
  asrEngine: AsrEngineLike;
  kwsEngine?: KwsEngineLike;
  ttsEngine?: TtsEngineLike;
  ttsState?: TtsRuntimeState;
  ttsError?: string | null;
  ttsLoading?: boolean;
}

const MAX_PCM_FRAME_BYTES = 256 * 1024;
const MAX_TTS_SOCKET_BUFFER_BYTES = 1024 * 1024;
const MAX_TTS_WAV_BYTES = 64 * 1024 * 1024;
const MAX_TTS_PLAYBACK_LEAD_MS = 500;

function currentTtsEngine(options: VoiceServerOptions): TtsEngineLike | undefined {
  return options.ttsState?.engine ?? options.ttsEngine;
}

function ttsStatus(options: VoiceServerOptions): {
  loading: boolean;
  error: string | null;
} {
  return {
    loading: options.ttsState?.loading ?? options.ttsLoading ?? false,
    error: options.ttsState?.error ?? options.ttsError ?? null,
  };
}

async function waitForTtsEngine(
  options: VoiceServerOptions,
  signal: AbortSignal,
): Promise<TtsEngineLike> {
  let engine = currentTtsEngine(options);
  if (engine?.stream) return engine;
  const state = options.ttsState;
  if (state?.loading && state.ready) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const error = new Error("TTS generation aborted");
        error.name = "AbortError";
        reject(error);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      state.ready!.then(resolve, reject).finally(() => {
        signal.removeEventListener("abort", onAbort);
      });
    });
    engine = currentTtsEngine(options);
  }
  if (!engine?.stream) throw new Error(ttsStatus(options).error || "tts-unavailable");
  return engine;
}

function authorized(request: IncomingMessage, token: string | null): boolean {
  return token === null || request.headers.authorization === `Bearer ${token}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > 16 * 1024) throw new Error("request body exceeds 16 KiB");
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

async function handleTts(
  request: IncomingMessage,
  response: ServerResponse,
  engine: TtsEngineLike | undefined,
): Promise<void> {
  let ttsRequest: TtsRequest;
  try {
    ttsRequest = parseTtsRequest(await readJson(request));
  } catch (error) {
    sendJson(response, 400, { error: error instanceof Error ? error.message : "invalid-request" });
    return;
  }
  if (!engine) {
    sendJson(response, 503, { error: "tts-unavailable" });
    return;
  }
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    let generated: { wav: Buffer; sampleRate: number };
    if (engine.generate) {
      generated = await engine.generate(ttsRequest, controller.signal);
    } else if (engine.stream) {
      const stream = await engine.stream(ttsRequest, controller.signal);
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of stream.chunks) {
        bytes += chunk.length;
        if (bytes > MAX_TTS_WAV_BYTES) throw new Error("TTS WAV compatibility response exceeds limit");
        chunks.push(chunk);
      }
      await stream.completed;
      generated = { wav: encodePcm16Wav(Buffer.concat(chunks), stream.sampleRate), sampleRate: stream.sampleRate };
    } else {
      sendJson(response, 503, { error: "tts-unavailable" });
      return;
    }
    if (controller.signal.aborted || response.destroyed) return;
    response.writeHead(200, {
      "Content-Type": "audio/wav",
      "Content-Length": generated.wav.length,
      "X-Voice-Generation": String(ttsRequest.generation),
      "Cache-Control": "no-store",
    });
    response.end(generated.wav);
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) return;
    if (error instanceof TtsOverloadedError) {
      sendJson(response, 429, { error: error.code });
      return;
    }
    sendJson(response, 500, { error: error instanceof Error ? error.message : "tts-failed" });
  }
}

function sendSocketJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function sendSocketBinary(socket: WebSocket, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("TTS socket is closed"));
      return;
    }
    socket.send(chunk, { binary: true }, (error) => error ? reject(error) : resolve());
  });
}

function pcmSamples(data: RawData): Float32Array {
  const source = Array.isArray(data)
    ? Buffer.concat(data)
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (source.length > MAX_PCM_FRAME_BYTES) throw new Error("PCM frame exceeds 256 KiB");
  if (source.length % 4 !== 0) throw new Error("PCM frame must contain complete float32 samples");
  const copy = Buffer.from(source);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.length / 4);
}

export async function createVoiceServer(options: VoiceServerOptions): Promise<VoiceServer> {
  const httpServer = createServer((request, response) => {
    if (!authorized(request, options.token)) {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        ready: true,
        asr: true,
        kws: Boolean(options.kwsEngine),
        tts: Boolean(currentTtsEngine(options)?.stream),
        ttsLoading: ttsStatus(options).loading,
        ttsError: ttsStatus(options).error,
      });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/tts") {
      void handleTts(request, response, currentTtsEngine(options));
      return;
    }
    sendJson(response, 404, { error: "not-found" });
  });
  const asrWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PCM_FRAME_BYTES });
  const ttsWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const sockets = new Set<Socket>();

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/v1/asr" && pathname !== "/v1/tts/stream") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!authorized(request, options.token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const server = pathname === "/v1/asr" ? asrWebSocketServer : ttsWebSocketServer;
    server.handleUpgrade(request, socket, head, (client) => {
      server.emit("connection", client, request);
    });
  });

  asrWebSocketServer.on("connection", (socket) => {
    let asrSession: AsrSession | null = null;
    let kwsSession: KwsSession | null = null;
    let sessionId: string | null = null;
    let generation: number | null = null;
    const emit = (event: AsrResultEvent | KwsResultEvent) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    };
    const hasSession = () => asrSession !== null || kwsSession !== null;
    const closeSessions = () => {
      kwsSession?.close();
      kwsSession = null;
      asrSession?.close();
      asrSession = null;
    };
    const sendError = (code: string, message: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "error", code, message }));
      }
    };
    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          const session = kwsSession ?? asrSession;
          if (!session) {
            sendError("not-started", "ASR start is required before audio");
            return;
          }
          session.acceptPcm(pcmSamples(data));
          return;
        }
        const control = parseAsrControl(data.toString());
        if (control.type === "start") {
          if (hasSession()) throw new Error("ASR session is already started");
          sessionId = control.sessionId;
          generation = control.generation;
          const useKws = control.mode === "wake"
            && control.wakeWord === "小智"
            && options.kwsEngine !== undefined;
          if (useKws) {
            kwsSession = options.kwsEngine!.createSession(sessionId, generation, (event) => {
              kwsSession?.close();
              kwsSession = null;
              asrSession = options.asrEngine.createSession(sessionId as string, generation as number, emit);
              emit(event);
            });
          } else {
            asrSession = options.asrEngine.createSession(sessionId, generation, emit);
          }
          socket.send(JSON.stringify({
            type: "ready",
            sessionId,
            generation,
            strategy: useKws ? "kws" : "asr",
          }));
          return;
        }
        if (!hasSession() || control.sessionId !== sessionId || control.generation !== generation) {
          throw new Error("control does not match the active ASR generation");
        }
        if (control.type === "reset") (kwsSession ?? asrSession)?.reset();
        if (control.type === "finish") {
          asrSession?.finish();
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: "finished", sessionId, generation }));
          }
        }
        if (control.type === "stop") {
          closeSessions();
          socket.close(1000, "stopped");
        }
      } catch (error) {
        sendError("invalid-message", error instanceof Error ? error.message : "invalid message");
      }
    });
    socket.on("close", closeSessions);
  });

  ttsWebSocketServer.on("connection", (socket) => {
    let active: { sessionId: string; generation: number; controller: AbortController } | null = null;
    const sendError = (code: string, message: string, sessionId?: string, generation?: number) => {
      sendSocketJson(socket, {
        type: "error",
        code,
        message,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(generation === undefined ? {} : { generation }),
      });
    };

    const run = async (start: TtsRequest, controller: AbortController) => {
      try {
        const engine = await waitForTtsEngine(options, controller.signal);
        const stream = await engine.stream!(start, controller.signal);
        let completionError: unknown;
        const completion = stream.completed.catch((error) => {
          completionError = error;
        });
        if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
        sendSocketJson(socket, {
          type: "started",
          sessionId: start.sessionId,
          generation: start.generation,
          sampleRate: stream.sampleRate,
          channels: stream.channels,
          sampleFormat: stream.sampleFormat,
        });
        const playbackClockStartedAt = performance.now();
        let sentAudioMs = 0;
        for await (const chunk of stream.chunks) {
          if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
          const chunkAudioMs = (chunk.byteLength / (2 * stream.channels * stream.sampleRate)) * 1_000;
          const projectedLeadMs = sentAudioMs + chunkAudioMs
            - (performance.now() - playbackClockStartedAt);
          if (projectedLeadMs > MAX_TTS_PLAYBACK_LEAD_MS) {
            await delay(projectedLeadMs - MAX_TTS_PLAYBACK_LEAD_MS, undefined, {
              signal: controller.signal,
            });
          }
          if (socket.bufferedAmount > MAX_TTS_SOCKET_BUFFER_BYTES) {
            controller.abort();
            throw new Error("tts-buffer-overflow");
          }
          await sendSocketBinary(socket, chunk);
          sentAudioMs += chunkAudioMs;
        }
        await completion;
        if (completionError) throw completionError;
        if (controller.signal.aborted) throw new DOMException("aborted", "AbortError");
        sendSocketJson(socket, {
          type: "finished",
          sessionId: start.sessionId,
          generation: start.generation,
        });
      } catch (error) {
        const cancelled = controller.signal.aborted
          || (error instanceof Error && error.name === "AbortError");
        if (cancelled) {
          sendSocketJson(socket, {
            type: "cancelled",
            sessionId: start.sessionId,
            generation: start.generation,
          });
        } else {
          sendError(
            error instanceof Error && error.message === "tts-buffer-overflow"
              ? "tts-buffer-overflow"
              : "tts-failed",
            error instanceof Error ? error.message : "TTS synthesis failed",
            start.sessionId,
            start.generation,
          );
        }
      } finally {
        if (active?.controller === controller) active = null;
      }
    };

    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        sendError("invalid-message", "TTS controls must be JSON text");
        return;
      }
      try {
        const control = parseTtsStreamControl(data.toString());
        if (control.type === "start") {
          if (active) throw new Error("TTS generation is already active");
          const status = ttsStatus(options);
          if (!currentTtsEngine(options)?.stream && !status.loading) {
            sendError("tts-unavailable", status.error || "TTS is unavailable", control.sessionId, control.generation);
            return;
          }
          const controller = new AbortController();
          active = { sessionId: control.sessionId, generation: control.generation, controller };
          void run(control, controller);
          return;
        }
        if (!active
          || control.sessionId !== active.sessionId
          || control.generation !== active.generation) {
          throw new Error("control does not match the active TTS generation");
        }
        active.controller.abort();
      } catch (error) {
        sendError("invalid-message", error instanceof Error ? error.message : "invalid message");
      }
    });
    socket.on("close", () => active?.controller.abort());
  });

  httpServer.listen(options.port, options.host);
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("voice service has no TCP address");
  const httpUrl = `http://${options.host}:${address.port}`;

  return {
    httpUrl,
    wsUrl: httpUrl.replace(/^http/, "ws"),
    async close() {
      for (const client of asrWebSocketServer.clients) client.terminate();
      for (const client of ttsWebSocketServer.clients) client.terminate();
      await Promise.all([
        new Promise<void>((resolve) => asrWebSocketServer.close(() => resolve())),
        new Promise<void>((resolve) => ttsWebSocketServer.close(() => resolve())),
      ]);
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          error ? reject(error) : resolve();
        });
        for (const socket of sockets) socket.destroy();
      });
    },
  };
}
