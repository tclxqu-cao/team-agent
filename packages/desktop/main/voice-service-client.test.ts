import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import {
  VoiceServiceClient,
  VoiceServiceTtsError,
  isCurrentVoiceEvent,
  type VoiceServiceEvent,
} from "./voice-service-client";

const services: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for voice fixture events");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function fixture(
  onTtsStart?: (
    socket: WebSocket,
    start: Record<string, unknown>,
  ) => void,
) {
  const received: number[] = [];
  const starts: Array<Record<string, unknown>> = [];
  const ttsStarts: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    if (request.headers.authorization !== "Bearer secret") {
      response.writeHead(401).end();
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
  websocketServer.on("connection", (socket, request) => {
    if (request.url === "/v1/tts/stream") {
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const control = JSON.parse(data.toString()) as Record<string, unknown>;
        if (control.type === "start") {
          ttsStarts.push(control);
          onTtsStart?.(socket, control);
        }
      });
      return;
    }
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
        starts.push(control);
        sessionId = control.sessionId;
        generation = control.generation;
        socket.send(JSON.stringify({ type: "ready", sessionId, generation, strategy: "kws" }));
        socket.send(JSON.stringify({ type: "keyword", sessionId, generation, keyword: "小智" }));
      } else if (control.type === "finish") {
        socket.send(JSON.stringify({ type: "final", sessionId, generation, utteranceId: 1, text: "你好小智" }));
        socket.send(JSON.stringify({ type: "finished", sessionId, generation }));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing fixture address");
  const service = {
    httpUrl: `http://127.0.0.1:${address.port}`,
    disconnect() {
      for (const client of websocketServer.clients) client.terminate();
    },
    async close() {
      for (const client of websocketServer.clients) client.terminate();
      websocketServer.close();
      const closed = once(server, "close");
      server.close();
      await closed;
    },
  };
  services.push(service);
  return { service, received, starts, ttsStarts };
}

describe("VoiceServiceClient", () => {
  it("waits for ready, forwards PCM, and receives partial and final events", async () => {
    const { service, received, starts } = await fixture();
    const events: VoiceServiceEvent[] = [];
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });

    await client.startAsr({ sessionId: "voice-1", generation: 7, mode: "wake", wakeWord: "小智" }, (event) => events.push(event));
    client.sendPcm(Buffer.from(new Float32Array([0.25, -0.5]).buffer));
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.finishAsr();
    await waitFor(() => events.length === 4);

    expect(received).toEqual([0.25, -0.5]);
    expect(starts).toEqual([{
      type: "start",
      sessionId: "voice-1",
      generation: 7,
      mode: "wake",
      wakeWord: "小智",
      sampleRate: 16_000,
    }]);
    expect(events).toEqual([
      { type: "keyword", sessionId: "voice-1", generation: 7, keyword: "小智" },
      { type: "partial", sessionId: "voice-1", generation: 7, text: "你好" },
      { type: "final", sessionId: "voice-1", generation: 7, utteranceId: 1, text: "你好小智" },
      { type: "finished", sessionId: "voice-1", generation: 7 },
    ]);
    client.close();
  });

  it("rejects stale session or generation events", () => {
    const current = { sessionId: "voice-2", generation: 9 };
    expect(isCurrentVoiceEvent({ type: "partial", sessionId: "voice-2", generation: 9, text: "当前" }, current)).toBe(true);
    expect(isCurrentVoiceEvent({ type: "partial", sessionId: "voice-2", generation: 8, text: "旧" }, current)).toBe(false);
    expect(isCurrentVoiceEvent({ type: "partial", sessionId: "voice-1", generation: 9, text: "旧" }, current)).toBe(false);
    expect(isCurrentVoiceEvent({ type: "keyword", sessionId: "voice-2", generation: 9, keyword: "小智" }, current)).toBe(true);
    expect(isCurrentVoiceEvent({ type: "keyword", sessionId: "voice-2", generation: 8, keyword: "小智" }, current)).toBe(false);
  });

  it("reports an unexpected ASR disconnect after readiness", async () => {
    const { service } = await fixture();
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    const disconnects: Error[] = [];

    await client.startAsr(
      { sessionId: "voice-disconnect", generation: 10, mode: "wake", wakeWord: "小智" },
      () => {},
      (error) => disconnects.push(error),
    );
    service.disconnect();
    await waitFor(() => disconnects.length === 1);

    expect(disconnects[0].message).toBe("voice service ASR disconnected");
    client.close();
  });

  it("streams authenticated PCM after validated metadata", async () => {
    const { service, ttsStarts } = await fixture((socket, start) => {
      socket.send(JSON.stringify({
        type: "started",
        sessionId: start.sessionId,
        generation: start.generation,
        sampleRate: 24_000,
        channels: 1,
        sampleFormat: "s16le",
      }));
      socket.send(Buffer.from([0, 0, 1, 0]));
      socket.send(JSON.stringify({
        type: "finished",
        sessionId: start.sessionId,
        generation: start.generation,
      }));
    });
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    const metadata: unknown[] = [];
    const pcm: Buffer[] = [];

    await client.streamSynthesize(
      { sessionId: "voice-1", generation: 12, text: "这是回答。", voice: "Serena", speed: 1 },
      new AbortController().signal,
      { onStarted: (value) => metadata.push(value), onPcm: (chunk) => pcm.push(chunk) },
    );

    expect(metadata).toEqual([{
      sessionId: "voice-1",
      generation: 12,
      sampleRate: 24_000,
      channels: 1,
      sampleFormat: "s16le",
    }]);
    expect(pcm).toEqual([Buffer.from([0, 0, 1, 0])]);
    expect(ttsStarts).toEqual([{
      type: "start",
      sessionId: "voice-1",
      generation: 12,
      text: "这是回答。",
      voice: "Serena",
      speed: 1,
    }]);
  });

  it("stops ASR without closing an active TTS stream", async () => {
    let ttsSocket: WebSocket | null = null;
    const { service } = await fixture((socket, start) => {
      ttsSocket = socket;
      socket.send(JSON.stringify({
        type: "started",
        sessionId: start.sessionId,
        generation: start.generation,
        sampleRate: 24_000,
        channels: 1,
        sampleFormat: "s16le",
      }));
    });
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    await client.startAsr(
      { sessionId: "wake-shared-client", generation: 14, mode: "wake", wakeWord: "小智" },
      () => {},
    );
    let ttsStarted = false;
    const synthesis = client.streamSynthesize(
      { sessionId: "tts-shared-client", generation: 15, text: "下一轮" },
      new AbortController().signal,
      { onStarted: () => { ttsStarted = true; }, onPcm: () => {} },
    );
    await waitFor(() => ttsStarted);

    client.stopAsr();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ttsSocket).not.toBeNull();
    const activeTtsSocket = ttsSocket as unknown as WebSocket;
    expect(activeTtsSocket.readyState).toBe(WebSocket.OPEN);
    activeTtsSocket.send(JSON.stringify({
      type: "finished",
      sessionId: "tts-shared-client",
      generation: 15,
    }));
    await expect(synthesis).resolves.toBeUndefined();
    client.close();
  });

  it.each([
    ["PCM before started", (socket: WebSocket) => socket.send(Buffer.from([0, 0])), "before started"],
    ["invalid metadata", (socket: WebSocket, start: Record<string, unknown>) => socket.send(JSON.stringify({
      type: "started", sessionId: start.sessionId, generation: start.generation,
      sampleRate: 44_100, channels: 1, sampleFormat: "s16le",
    })), "invalid audio metadata"],
    ["stale generation", (socket: WebSocket, start: Record<string, unknown>) => socket.send(JSON.stringify({
      type: "started", sessionId: start.sessionId, generation: Number(start.generation) - 1,
      sampleRate: 24_000, channels: 1, sampleFormat: "s16le",
    })), "stale generation"],
  ])("rejects %s", async (_name, respond, message) => {
    const { service } = await fixture(respond);
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    await expect(client.streamSynthesize(
      { sessionId: "voice-invalid", generation: 8, text: "失败" },
      new AbortController().signal,
      { onStarted: () => {}, onPcm: () => {} },
    )).rejects.toThrow(message);
  });

  it("preserves structured streaming errors", async () => {
    const { service } = await fixture((socket, start) => socket.send(JSON.stringify({
      type: "error",
      sessionId: start.sessionId,
      generation: start.generation,
      code: "tts-unavailable",
      message: "model missing",
    })));
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    const pending = client.streamSynthesize(
      { sessionId: "voice-error", generation: 9, text: "失败" },
      new AbortController().signal,
      { onStarted: () => {}, onPcm: () => {} },
    );
    await expect(pending).rejects.toMatchObject({ status: 0, code: "tts-unavailable" });
    await expect(pending).rejects.toBeInstanceOf(VoiceServiceTtsError);
  });

  it("sends a matching cancel and rejects with AbortError", async () => {
    let cancel: Record<string, unknown> | null = null;
    const { service } = await fixture((socket, start) => {
      socket.send(JSON.stringify({
        type: "started", sessionId: start.sessionId, generation: start.generation,
        sampleRate: 24_000, channels: 1, sampleFormat: "s16le",
      }));
      socket.on("message", (data, isBinary) => {
        if (isBinary) return;
        const control = JSON.parse(data.toString()) as Record<string, unknown>;
        if (control.type !== "cancel") return;
        cancel = control;
        socket.send(JSON.stringify({
          type: "cancelled",
          sessionId: start.sessionId,
          generation: start.generation,
        }));
      });
    });
    const client = new VoiceServiceClient({ baseUrl: service.httpUrl, token: "secret" });
    const controller = new AbortController();
    const pending = client.streamSynthesize(
      { sessionId: "voice-cancel", generation: 13, text: "停止" },
      controller.signal,
      { onStarted: () => controller.abort(), onPcm: () => {} },
    );
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toEqual({ type: "cancel", sessionId: "voice-cancel", generation: 13 });
  });

  it("times out before started and aborts active synthesis when closed", async () => {
    const { service } = await fixture();
    const timedClient = new VoiceServiceClient({
      baseUrl: service.httpUrl,
      token: "secret",
      ttsStartTimeoutMs: 20,
    });
    await expect(timedClient.streamSynthesize(
      { sessionId: "voice-timeout", generation: 1, text: "等待" },
      new AbortController().signal,
      { onStarted: () => {}, onPcm: () => {} },
    )).rejects.toThrow("timed out");

    const { service: activeService } = await fixture((socket, start) => {
      socket.send(JSON.stringify({
        type: "started", sessionId: start.sessionId, generation: start.generation,
        sampleRate: 24_000, channels: 1, sampleFormat: "s16le",
      }));
    });
    const activeClient = new VoiceServiceClient({ baseUrl: activeService.httpUrl, token: "secret" });
    let started = false;
    const active = activeClient.streamSynthesize(
      { sessionId: "voice-close", generation: 2, text: "关闭" },
      new AbortController().signal,
      { onStarted: () => { started = true; }, onPcm: () => {} },
    );
    await waitFor(() => started);
    activeClient.close();
    await expect(active).rejects.toThrow("closed before completion");
  });
});
