import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createVoiceAsrGateway } from "./voice-asr-gateway.mjs";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function fixture() {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const received: Array<{ data: Buffer; binary: boolean }> = [];
  let peer: WebSocket;
  upstream.on("connection", (socket) => {
    peer = socket;
    socket.on("message", (data, binary) => {
      received.push({ data: Buffer.from(data as Buffer), binary });
      if (binary) return;
      const control = JSON.parse(data.toString());
      if (control.type === "start") socket.send(JSON.stringify({ ...control, type: "ready" }));
      if (control.type === "finish") {
        socket.send(JSON.stringify({ ...control, type: "final", utteranceId: 1, text: "最后一个字" }));
        socket.send(JSON.stringify({ ...control, type: "finished" }));
      }
    });
  });
  let active = true;
  const pairing = {
    authenticateUpgrade: (req: { headers: Record<string, string> }) => req.headers.authorization === "Bearer paired" ? { deviceId: "phone" } : null,
    active: () => active,
    track: () => undefined,
  };
  const address = upstream.address() as { port: number };
  const gateway = createVoiceAsrGateway({ pairing, serviceUrl: `http://127.0.0.1:${address.port}` });
  const server = createServer();
  server.on("upgrade", (req, socket, head) => { if (!gateway.handleUpgrade(req, socket, head)) socket.destroy(); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => { for (const socket of upstream.clients) socket.terminate(); await new Promise<void>((resolve) => upstream.close(() => resolve())); });
  cleanup.push(async () => { await gateway.close(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}/ws/voice`;
  const open = async (authorized = true) => {
    const socket = new WebSocket(url, { headers: authorized ? { Authorization: "Bearer paired" } : undefined });
    await once(socket, "open");
    return socket;
  };
  const start = { type: "start", sessionId: "dictation-test", generation: 1, mode: "dictation", sampleRate: 16_000 };
  return { open, start, received, revoke: () => { active = false; }, disconnect: () => peer.terminate() };
}

function message(socket: WebSocket): Promise<Record<string, unknown>> {
  return once(socket, "message").then(([data]) => JSON.parse(data.toString()));
}

describe("authenticated voice gateway", () => {
  it("rejects unpaired upgrades", async () => {
    const f = await fixture();
    await expect(f.open(false)).rejects.toThrow(/401/);
  });

  it("relays PCM and preserves final text before the finished acknowledgement", async () => {
    const f = await fixture();
    const socket = await f.open();
    const ready = message(socket);
    socket.send(JSON.stringify(f.start));
    expect((await ready).type).toBe("ready");
    socket.send(Buffer.from(new Float32Array([0.1, -0.2]).buffer));
    const events: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => events.push(JSON.parse(raw.toString())));
    const closed = once(socket, "close");
    socket.send(JSON.stringify({ ...f.start, type: "finish" }));
    await closed;
    expect(f.received.find((frame) => frame.binary)?.data).toEqual(Buffer.from(new Float32Array([0.1, -0.2]).buffer));
    expect(events.map((event) => event.type)).toEqual(["final", "finished"]);
    expect(events[0].text).toBe("最后一个字");
  });

  it("rejects wake/TTS control instead of exposing additional sidecar capabilities", async () => {
    const f = await fixture();
    const socket = await f.open();
    const error = message(socket);
    socket.send(JSON.stringify({ ...f.start, mode: "wake" }));
    expect((await error).type).toBe("error");
    expect(f.received).toEqual([]);
  });

  it("stops forwarding audio when the device authorization is revoked", async () => {
    const f = await fixture();
    const socket = await f.open();
    const ready = message(socket);
    socket.send(JSON.stringify(f.start));
    await ready;
    f.revoke();
    const closed = once(socket, "close");
    socket.send(Buffer.from(new Float32Array([0.1]).buffer));
    expect((await closed)[0]).toBe(4003);
    expect(f.received.filter((frame) => frame.binary)).toEqual([]);
  });

  it("reports a sidecar disconnect and closes the browser session", async () => {
    const f = await fixture();
    const socket = await f.open();
    const ready = message(socket);
    socket.send(JSON.stringify(f.start));
    await ready;
    const error = message(socket);
    const closed = once(socket, "close");
    f.disconnect();
    expect((await error).type).toBe("error");
    await closed;
  });
});
