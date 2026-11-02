import { EventEmitter, once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopDiscovery } from "./desktop-discovery.mjs";
import { createTunnelControlGateway } from "./tunnel-control.mjs";

const closers: Array<() => Promise<unknown> | void> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture(connected = true) {
  const root = await mkdtemp(join(tmpdir(), "tunnel-control-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const desktop = createDesktopDiscovery({ dataDir: root, directory: join(root, "registry") });
  const parent = Object.assign(new EventEmitter(), { connected, send: vi.fn((_message: unknown, callback: (error?: Error) => void) => callback()) });
  const control = createTunnelControlGateway({ desktop, parent });
  const server = createServer((req, res) => { if (desktop.handle(req, res) || control.handle(req, res)) return; res.writeHead(404).end(); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  await desktop.publish(port);
  closers.push(async () => { control.close(); await desktop.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const request = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);
  return { parent, request, headers: desktop.headers() };
}

describe("local desktop tunnel management", () => {
  it("rejects anonymous, phone bearer and invalid desktop credentials for reads and writes", async () => {
    const f = await fixture();
    for (const headers of [{}, { authorization: `Bearer ${"t".repeat(43)}` }, { "x-agentroam-desktop-token": "a".repeat(64) }]) {
      expect((await f.request("/api/desktop/tunnel", { headers })).status).toBe(401);
      expect((await f.request("/api/desktop/tunnel/connect", { method: "POST", headers })).status).toBe(401);
    }
    expect(f.parent.send).not.toHaveBeenCalled();
  });
  it("returns immediately, merges repeated clicks and exposes updated parent status", async () => {
    const f = await fixture();
    const local = { phase: "idle", mode: "lan", provider: "lan", accessUrl: "http://192.168.1.10:3000/web" };
    f.parent.emit("message", { type: "agentroam:tunnel-status", status: local });
    expect(await (await f.request("/api/desktop/tunnel", { headers: f.headers })).json()).toEqual(local);
    for (let n = 0; n < 2; n++) {
      const response = await f.request("/api/desktop/tunnel/connect", { method: "POST", headers: f.headers });
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ phase: "connecting", mode: "lan" });
    }
    expect(f.parent.send).toHaveBeenCalledOnce();
    const ready = { phase: "ready", mode: "public", provider: "cloudflare", accessUrl: "https://working.example/web" };
    f.parent.emit("message", { type: "agentroam:tunnel-status", status: ready });
    expect(await (await f.request("/api/desktop/tunnel", { headers: f.headers })).json()).toEqual(ready);
    expect((await f.request("/api/desktop/tunnel/connect", { method: "POST", headers: f.headers })).status).toBe(202);
    expect(f.parent.send).toHaveBeenCalledOnce();
  });
  it("reports unsupported unmanaged servers and disconnected parents without spawning anything", async () => {
    const f = await fixture(false);
    expect(await (await f.request("/api/desktop/tunnel", { headers: f.headers })).json()).toMatchObject({ phase: "unsupported" });
    expect((await f.request("/api/desktop/tunnel/connect", { method: "POST", headers: f.headers })).status).toBe(503);
    f.parent.connected = true;
    f.parent.emit("disconnect");
    expect(await (await f.request("/api/desktop/tunnel", { headers: f.headers })).json()).toMatchObject({ phase: "unsupported", error: expect.stringContaining("已断开") });
    expect(f.parent.send).not.toHaveBeenCalled();
  });
});
