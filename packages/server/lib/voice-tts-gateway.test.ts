import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createVoiceTtsGateway } from "./voice-tts-gateway.mjs";
import { BrowserSpeechOutput } from "../../webapp/src/infrastructure/voice/browser-speech-output";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
});

async function fixture() {
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("WebSocket", WebSocket);
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const received: Array<Record<string, unknown>> = [];
  let upstreamAuthorization: string | undefined;
  let peer: WebSocket | undefined;
  let current: Record<string, unknown> = {};
  upstream.on("connection", (socket, req) => {
    upstreamAuthorization = req.headers.authorization;
    peer = socket;
    socket.on("message", (data) => {
      const control = JSON.parse(data.toString());
      received.push(control);
      if (control.type === "start") {
        current = { sessionId: control.sessionId, generation: control.generation };
        socket.send(JSON.stringify({ type: "started", ...current, sampleRate: 24_000, channels: 1, sampleFormat: "s16le" }));
      }
    });
  });
  let active = true;
  const pairing = {
    authenticateUpgrade: (req: { headers: Record<string, string> }) => req.headers.authorization === "Bearer paired" ? { deviceId: "phone" } : null,
    active: () => active, track: () => {},
  };
  const address = upstream.address() as { port: number };
  const gateway = createVoiceTtsGateway({ pairing, serviceUrl: `http://127.0.0.1:${address.port}`, token: "private-sidecar-token" });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => { if (!gateway.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => { for (const socket of upstream.clients) socket.terminate(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  cleanup.push(async () => { await gateway.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/voice/tts`;
  const open = (authorized = true) => new WebSocket(url, { headers: authorized ? { Authorization: "Bearer paired" } : undefined });
  const output = new BrowserSpeechOutput(async () => open() as unknown as globalThis.WebSocket);
  return {
    output, open, received, authorization: () => upstreamAuthorization,
    audio: () => peer!.send(Buffer.from([0, 128, 255, 127]), { binary: true }),
    finish: () => peer!.send(JSON.stringify({ type: "finished", ...current })),
    fail: () => peer!.send(JSON.stringify({ type: "error", message: "secret-key-and-url" })),
    revoke: () => { active = false; },
  };
}

describe("paired browser speech output", () => {
  it("rejects unpaired devices", async () => {
    const f = await fixture();
    const socket = f.open(false);
    await expect(once(socket, "open")).rejects.toThrow("401");
  });

  it("runs browser adapter through the gateway with PCM and a playback acknowledgement", async () => {
    const f = await fixture();
    const starts = vi.fn(); const pcm = vi.fn(); const finishes = vi.fn(); const ends = vi.fn();
    f.output.onTtsStart(starts); f.output.onTtsPcm(pcm); f.output.onTtsStreamEnd(finishes); f.output.onTtsEnd(ends);
    const speaking = f.output.ttsSpeak("端到端播报");
    await vi.waitFor(() => expect(starts).toHaveBeenCalledOnce());
    const metadata = starts.mock.calls[0][0];
    expect(ends).not.toHaveBeenCalled();
    expect(metadata).toMatchObject({ sampleRate: 24_000, channels: 1, sampleFormat: "s16le" });
    expect(f.authorization()).toBe("Bearer private-sidecar-token");
    expect(f.received[0]).toMatchObject({ type: "start", text: "端到端播报" });
    f.audio(); f.finish();
    expect(await speaking).toEqual({ ok: true });
    expect(Buffer.from(pcm.mock.calls[0][0].pcm)).toEqual(Buffer.from([0, 128, 255, 127]));
    expect(finishes).toHaveBeenCalledWith(expect.objectContaining({ generation: metadata.generation }));
    ends.mockClear();
    await f.output.ttsPlaybackEnded(metadata.generation - 1);
    expect(ends).not.toHaveBeenCalled();
    await f.output.ttsPlaybackEnded(metadata.generation);
    expect(ends).toHaveBeenCalledOnce();
  });

  it("cancels the current stream and flushes queued playback", async () => {
    const f = await fixture();
    const starts = vi.fn(); const flush = vi.fn();
    f.output.onTtsStart(starts); f.output.onTtsFlush(flush);
    const speaking = f.output.ttsSpeak("会被取消");
    await vi.waitFor(() => expect(starts).toHaveBeenCalledOnce());
    await f.output.ttsStop();
    expect(await speaking).toEqual({ ok: true });
    expect(flush).toHaveBeenCalledWith(expect.objectContaining({ generation: starts.mock.calls[0][0].generation }));
  });

  it("does not leak upstream errors to browser callers", async () => {
    const f = await fixture();
    const speaking = f.output.ttsSpeak("失败测试");
    const rejected = expect(speaking).rejects.toThrow("语音合成失败");
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.fail();
    await rejected;
  });

  it("stops streaming after pairing authorization is revoked", async () => {
    const f = await fixture();
    const pcm = vi.fn(); f.output.onTtsPcm(pcm);
    const speaking = f.output.ttsSpeak("撤销测试");
    const rejected = expect(speaking).rejects.toThrow("连接已断开");
    await vi.waitFor(() => expect(f.received).toHaveLength(1));
    f.revoke(); f.audio();
    await rejected;
    expect(pcm).not.toHaveBeenCalled();
  });
});
