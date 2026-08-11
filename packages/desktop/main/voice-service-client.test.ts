import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  VoiceServiceClient,
  isCurrentVoiceEvent,
  type VoiceServiceEvent,
} from "./voice-service-client";

const services: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function fixture(tts?: (signal: AbortSignal) => Promise<Buffer>) {
  const received: number[] = [];
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== "Bearer secret") {
      response.writeHead(401).end();
      return;
    }
    if (request.method === "POST" && request.url === "/v1/tts" && tts) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { generation: number };
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      try {
        const wav = await tts(controller.signal);
        response.writeHead(200, {
          "Content-Type": "audio/wav",
          "X-Voice-Generation": String(body.generation),
        });
        response.end(wav);
      } catch {
        if (!response.destroyed) response.writeHead(500).end();
      }
      return;
    }
    response.writeHead(404).end();
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization !== "Bearer secret") {
      socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (client) => websocketServer.emit("connection", client, request));
  });
  websocketServer.on("connection", (socket) => {
    let sessionId = "";
    let generation = 0;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const bytes = Buffer.from(data as Buffer);
        const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
        received.push(...samples);
        socket.send(JSON.stringify({ type: "partial", sessionId, generation, text: "你好" }));
        return;
      }
      const control = JSON.parse(data.toString());
      if (control.type === "start") {
        sessionId = control.sessionId;
        generation = control.generation;
        socket.send(JSON.stringify({ type: "ready", sessionId, generation }));
      } else if (control.type === "finish") {
        socket.send(JSON.stringify({ type: "final", sessionId, generation, utteranceId: 1, text: "你好小智" }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const service = {
    httpUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      server.close();
      await once(server, "close");
    },
  };
  services.push(service);
  return { service, received };
}

describe("VoiceServiceClient", () => {
  it("waits for ready, forwards PCM, and receives partial and final events", async () => {
    const { service, received } = await fixture();
    const events: VoiceServiceEvent[] = [];
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });

    await client.startAsr({ sessionId: "voice-1", generation: 7, mode: "wake" }, (event) => events.push(event));
    client.sendPcm(Buffer.from(new Float32Array([0.25, -0.5]).buffer));
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.finishAsr();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received).toEqual([0.25, -0.5]);
    expect(events).toEqual([
      { type: "partial", sessionId: "voice-1", generation: 7, text: "你好" },
      { type: "final", sessionId: "voice-1", generation: 7, utteranceId: 1, text: "你好小智" },
    ]);
    client.close();
  });

  it("rejects stale session or generation events", () => {
    const current = { sessionId: "voice-2", generation: 9 };
    expect(isCurrentVoiceEvent({ type: "partial", sessionId: "voice-2", generation: 9, text: "当前" }, current)).toBe(true);
    expect(isCurrentVoiceEvent({ type: "partial", sessionId: "voice-2", generation: 8, text: "旧" }, current)).toBe(false);
    expect(isCurrentVoiceEvent({ type: "partial", sessionId: "voice-1", generation: 9, text: "旧" }, current)).toBe(false);
  });

  it("requests generated WAV with auth and generation", async () => {
    const { service } = await fixture(async () => Buffer.from("RIFF-audio"));
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    const wav = await client.synthesize({ sessionId: "voice-1", generation: 12, text: "这是回答。" }, new AbortController().signal);
    expect(wav.toString()).toBe("RIFF-audio");
  });

  it("propagates synthesis cancellation", async () => {
    const { service } = await fixture(async (signal) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          }, { once: true });
        });
        return Buffer.from("late");
    });
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    const controller = new AbortController();
    const pending = client.synthesize({ sessionId: "voice-1", generation: 13, text: "停止" }, controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
  });
});
