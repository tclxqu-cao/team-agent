import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { AsrResultEvent, AsrSession } from "./asr-engine.js";
import { parseAsrControl, parseTtsRequest, type TtsRequest } from "./protocol.js";

export interface AsrEngineLike {
  createSession(
    sessionId: string,
    generation: number,
    emit: (event: AsrResultEvent) => void,
  ): AsrSession;
}

export interface TtsEngineLike {
  generate(
    request: TtsRequest,
    signal: AbortSignal,
  ): Promise<{ wav: Buffer; sampleRate: number }>;
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
  ttsEngine?: TtsEngineLike;
}

const MAX_PCM_FRAME_BYTES = 256 * 1024;

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
    const generated = await engine.generate(ttsRequest, controller.signal);
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
    sendJson(response, 500, { error: error instanceof Error ? error.message : "tts-failed" });
  }
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
      sendJson(response, 200, { ready: true, asr: true, tts: Boolean(options.ttsEngine) });
      return;
    }
    if (request.method === "POST" && request.url === "/v1/tts") {
      void handleTts(request, response, options.ttsEngine);
      return;
    }
    sendJson(response, 404, { error: "not-found" });
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_PCM_FRAME_BYTES });

  httpServer.on("upgrade", (request, socket, head) => {
    if (request.url !== "/v1/asr") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    if (!authorized(request, options.token)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => {
      websocketServer.emit("connection", client, request);
    });
  });

  websocketServer.on("connection", (socket) => {
    let session: AsrSession | null = null;
    let sessionId: string | null = null;
    let generation: number | null = null;
    const emit = (event: AsrResultEvent) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    };
    const sendError = (code: string, message: string) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "error", code, message }));
      }
    };
    socket.on("message", (data, isBinary) => {
      try {
        if (isBinary) {
          if (!session) {
            sendError("not-started", "ASR start is required before audio");
            return;
          }
          session.acceptPcm(pcmSamples(data));
          return;
        }
        const control = parseAsrControl(data.toString());
        if (control.type === "start") {
          if (session) throw new Error("ASR session is already started");
          sessionId = control.sessionId;
          generation = control.generation;
          session = options.asrEngine.createSession(sessionId, generation, emit);
          socket.send(JSON.stringify({ type: "ready", sessionId, generation }));
          return;
        }
        if (!session || control.sessionId !== sessionId || control.generation !== generation) {
          throw new Error("control does not match the active ASR generation");
        }
        if (control.type === "reset") session.reset();
        if (control.type === "finish") session.finish();
        if (control.type === "stop") {
          session.close();
          session = null;
          socket.close(1000, "stopped");
        }
      } catch (error) {
        sendError("invalid-message", error instanceof Error ? error.message : "invalid message");
      }
    });
    socket.on("close", () => session?.close());
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
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      httpServer.close();
      await once(httpServer, "close");
    },
  };
}
