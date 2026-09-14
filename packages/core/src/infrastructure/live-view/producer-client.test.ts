import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { LiveViewProducerClient } from "./producer-client";

class FakeWebSocket extends EventEmitter {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];

  declare readyState: number;
  declare bufferedAmount: number;

  readonly sent: Array<string | Buffer> = [];
  readonly url: string;
  readonly options: { headers?: Record<string, string> };

  constructor(url: string, options: { headers?: Record<string, string> } = {}) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = FakeWebSocket.OPEN;
    this.bufferedAmount = 0;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open"));
  }

  send(data: string | Buffer) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function client(fetchImpl = vi.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ wsNonce: "nonce-123" }),
})) {
  FakeWebSocket.instances = [];
  return {
    fetchImpl,
    value: new LiveViewProducerClient({
      endpoint: "https://agent.example.test:3000/base",
      fetchImpl,
      WebSocketImpl: FakeWebSocket,
      timeoutMs: 100,
    }),
  };
}

function reply(socket: FakeWebSocket, request: Record<string, unknown>, result: Record<string, unknown> = {}) {
  socket.emit("message", Buffer.from(JSON.stringify({
    ...result,
    type: `${request.type}:result`,
    id: request._req,
  })));
}

describe("LiveViewProducerClient", () => {
  it("skips stale and identity-mismatched records before bootstrapping with the active credential", async () => {
    const directory = await mkdtemp(join(tmpdir(), "live-discovery-"));
    const stale = "a".repeat(64), active = "b".repeat(64);
    const probes: string[] = [];
    const server = createServer((req, res) => {
      const token = String(req.headers["x-agentroam-desktop-token"]);
      if (req.url === "/api/desktop/identity") {
        probes.push(token);
        res.writeHead(token === active ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ protocol: 1, instanceId: "active", dataDir: "/project" }));
      } else {
        res.writeHead(token === active ? 200 : 401, { "content-type": "application/json" });
        res.end(JSON.stringify({ wsNonce: "verified-nonce" }));
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const value = new LiveViewProducerClient({ endpoint, WebSocketImpl: FakeWebSocket });
    vi.stubEnv("AGENTROAM_DISCOVERY_DIR", directory);
    vi.stubEnv("AGENTROAM_LOCAL_SERVICE_URL", "");
    try {
      for (const [file, token, instanceId] of [["00-old", stale, "old"], ["01-mismatch", active, "wrong"], ["02-active", active, "active"]]) {
        await writeFile(join(directory, `${file}.json`), JSON.stringify({ protocol: 1, url: endpoint, token, instanceId, dataDir: "/project" }));
      }
      await value.connect();
      expect(probes).toEqual([stale, active, active]);
      expect(FakeWebSocket.instances.at(-1)?.options.headers?.["x-agentroam-desktop-token"]).toBe(active);
      expect(FakeWebSocket.instances.at(-1)?.url).toContain("verified-nonce");
    } finally {
      value.disconnect(); vi.unstubAllEnvs(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("authenticates local producers without leaking the credential to remote endpoints or redirects", async () => {
    vi.stubEnv("AGENTROAM_LOCAL_SERVICE_URL", "http://127.0.0.1:39991");
    vi.stubEnv("AGENTROAM_LOCAL_SERVICE_TOKEN", "local-credential");
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ wsNonce: "nonce" }) });
    const value = new LiveViewProducerClient({ endpoint: "http://127.0.0.1:39991", fetchImpl, WebSocketImpl: FakeWebSocket });
    try {
      await value.connect();
      expect(fetchImpl).toHaveBeenCalledWith(expect.any(URL), { cache: "no-store", headers: { "x-agentroam-desktop-token": "local-credential" }, redirect: "error" });
      expect(FakeWebSocket.instances.at(-1)?.options.headers).toMatchObject({ "x-agentroam-desktop-token": "local-credential" });
      value.disconnect();
      const remote = client(); await remote.value.connect();
      expect(remote.fetchImpl).toHaveBeenCalledWith(expect.any(URL), { cache: "no-store" });
      expect(FakeWebSocket.instances.at(-1)?.options.headers).not.toHaveProperty("x-agentroam-desktop-token");
      remote.value.disconnect();
    } finally { value.disconnect(); vi.unstubAllEnvs(); }
  });
  it("bootstraps an authenticated socket with the endpoint Origin", async () => {
    const { value, fetchImpl } = client();
    await value.connect();

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL("https://agent.example.test:3000/api/web-console/bootstrap"),
      { cache: "no-store" },
    );
    const socket = FakeWebSocket.instances[0];
    expect(socket.url).toBe("wss://agent.example.test:3000/ws?nonce=nonce-123");
    expect(socket.options.headers).toEqual({ Origin: "https://agent.example.test:3000" });
    value.disconnect();
  });

  it("falls back to Node HTTP when the runtime replaces global fetch with a facade", async () => {
    const previousFetch = globalThis.fetch;
    const server = createServer((request, response) => {
      expect(request.url).toBe("/api/web-console/bootstrap");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ wsNonce: "node-http-nonce" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    FakeWebSocket.instances = [];
    (globalThis as { fetch?: unknown }).fetch = { server: () => undefined };
    const value = new LiveViewProducerClient({
      endpoint: `http://127.0.0.1:${address.port}`,
      WebSocketImpl: FakeWebSocket,
      timeoutMs: 100,
    });
    try {
      await value.connect();
      expect(FakeWebSocket.instances[0].url).toBe(
        `ws://127.0.0.1:${address.port}/ws?nonce=node-http-nonce`,
      );
      value.disconnect();
    } finally {
      (globalThis as { fetch?: unknown }).fetch = previousFetch;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("correlates JSON RPC and publishes JPEG frames with the producer opcode", async () => {
    const { value } = client();
    await value.connect();
    const socket = FakeWebSocket.instances[0];
    const publishing = value.publish({
      sessionId: "live-1",
      title: "Example",
      url: "https://example.test/",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    });
    await Promise.resolve();
    const request = JSON.parse(socket.sent[0] as string);
    expect(request).toMatchObject({ type: "browser:publish", _req: 1, sessionId: "live-1" });
    reply(socket, request, { channelId: 37 });
    await expect(publishing).resolves.toMatchObject({ channelId: 37 });

    await expect(value.frame("live-1", {
      sequence: 9,
      data: Buffer.from([0xff, 0xd8, 0xff]),
      title: "Example",
      url: "https://example.test/",
      viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
    })).resolves.toEqual({ accepted: true });
    const packet = socket.sent[1] as Buffer;
    expect([...packet.subarray(0, 10)]).toEqual([1, 5, 0, 0, 0, 37, 0, 0, 0, 9]);
    expect([...packet.subarray(10)]).toEqual([0xff, 0xd8, 0xff]);
    value.disconnect();
  });

  it("drops frames under socket backpressure", async () => {
    const { value } = client();
    await value.connect();
    const socket = FakeWebSocket.instances[0];
    const publishing = value.publish({ sessionId: "live-1" });
    await Promise.resolve();
    reply(socket, JSON.parse(socket.sent[0] as string), { channelId: 2 });
    await publishing;
    socket.bufferedAmount = 2 * 1024 * 1024 + 1;

    await expect(value.frame("live-1", { sequence: 1, data: Buffer.from([1]) }))
      .resolves.toEqual({ accepted: false, dropped: "backpressure" });
    expect(socket.sent).toHaveLength(1);
    value.disconnect();
  });

  it("relays webrtc signaling as a producer rpc", async () => {
    const { value } = client();
    await value.connect();
    const socket = FakeWebSocket.instances[0];
    const relayed = value.webrtcRelay("live-1", { kind: "offer", sdp: { type: "offer", sdp: "v=0" } });
    await Promise.resolve();
    const request = JSON.parse(socket.sent[0] as string);
    expect(request).toMatchObject({ type: "browser:webrtc-relay", sessionId: "live-1" });
    expect(request.data).toMatchObject({ kind: "offer" });
    reply(socket, request, { delivered: true });
    await expect(relayed).resolves.toMatchObject({ delivered: true });
    value.disconnect();
  });

  it("rejects pending RPC calls when the socket disconnects", async () => {
    const { value } = client();
    await value.connect();
    const socket = FakeWebSocket.instances[0];
    const pending = value.rpc("browser:list");
    socket.emit("close");

    await expect(pending).rejects.toThrow("browser bridge disconnected");
    await expect(value.waitForDisconnect()).resolves.toBeUndefined();
  });

  it("closes a producer session only once when cleanup races", async () => {
    const { value } = client();
    await value.connect();
    const socket = FakeWebSocket.instances[0];

    const first = value.close("live-1");
    const second = value.close("live-1");
    expect(second).toBe(first);
    const request = JSON.parse(socket.sent[0] as string);
    expect(request).toMatchObject({ type: "browser:close", sessionId: "live-1" });
    reply(socket, request, { closed: true });
    await Promise.all([first, second]);
    expect(socket.sent).toHaveLength(1);
  });
});
