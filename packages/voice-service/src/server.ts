import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AsrResultEvent, AsrSession } from "./asr-engine.js";
import type { KwsResultEvent, KwsSession } from "./kws-engine.js";
import { parseAsrControl } from "./protocol.js";

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

export interface VoiceServer {
  httpUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

interface VoiceServerOptions {
  provider?: "local" | "azure";
  host: string;
  port: number;
  token: string | null;
  asrEngine: AsrEngineLike;
  kwsEngine?: KwsEngineLike;
}

const MAX_PCM_FRAME_BYTES = 256 * 1024;

function authorized(request: IncomingMessage, token: string | null): boolean {
  return token === null || request.headers.authorization === `Bearer ${token}`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
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
        provider: options.provider ?? "local",
        asr: true,
        kws: Boolean(options.kwsEngine),
      });
      return;
    }
    sendJson(response, 404, { error: "not-found" });
  });
  const asrWebSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PCM_FRAME_BYTES });
  const sockets = new Set<Socket>();

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  httpServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => socket.destroy());
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/v1/asr") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!authorized(request, options.token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    asrWebSocketServer.handleUpgrade(request, socket, head, (client) => {
      asrWebSocketServer.emit("connection", client, request);
    });
  });

  asrWebSocketServer.on("connection", (socket) => {
    let asrSession: AsrSession | null = null;
    let kwsSession: KwsSession | null = null;
    let sessionId: string | null = null;
    let generation: number | null = null;
    let pending = Promise.resolve();
    let pendingBytes = 0;
    let finished = false;
    const emit = (event: AsrResultEvent | KwsResultEvent) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
      if (event.type === "error") {
        closeSessions();
        socket.close(1011, "ASR provider failed");
      }
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
    const handleMessage = async (data: RawData, isBinary: boolean) => {
      try {
        if (isBinary) {
          const session = kwsSession ?? asrSession;
          if (!session) {
            sendError("not-started", "ASR start is required before audio");
            return;
          }
          if (finished) throw new Error("ASR input is already finished");
          if (asrSession?.ready) await asrSession.ready;
          if (socket.readyState !== WebSocket.OPEN) return;
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
            await asrSession.ready;
          }
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
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
        if (control.type === "reset") {
          await (kwsSession ?? asrSession)?.reset();
          finished = false;
        }
        if (control.type === "finish") {
          if (finished) throw new Error("ASR input is already finished");
          finished = true;
          await asrSession?.finish();
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
        closeSessions();
        socket.close(1008, "ASR request failed");
      }
    };
    socket.on("message", (data, isBinary) => {
      const bytes = Array.isArray(data) ? data.reduce((sum, part) => sum + part.length, 0) : data.byteLength;
      pendingBytes += bytes;
      if (pendingBytes > 1024 * 1024) {
        sendError("asr-buffer-overflow", "ASR pending audio exceeds 1 MiB");
        socket.close(1009, "ASR buffer overflow");
        return;
      }
      pending = pending.then(async () => {
        if (socket.readyState === WebSocket.OPEN) await handleMessage(data, isBinary);
      }).finally(() => { pendingBytes -= bytes; });
    });
    socket.on("close", closeSessions);
    socket.on("error", () => { closeSessions(); socket.terminate(); });
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
      await Promise.all([
        new Promise<void>((resolve) => asrWebSocketServer.close(() => resolve())),
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
