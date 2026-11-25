import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDesktopDiscovery } from "../../server/lib/desktop-discovery.mjs";
import { SharedServiceConnection, serviceApiUrl, validDescriptor, type TerminalSocketFrame } from "./shared-service";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "shared-service-"));
  closers.push(() => rm(root, { recursive: true, force: true }));
  const registry = join(root, "services");
  const start = async (name: string, handle?: (req: IncomingMessage, res: ServerResponse) => void) => {
    const discovery = createDesktopDiscovery({ dataDir: join(root, name), directory: registry });
    const server = createServer((req, res) => { if (discovery.handle(req, res)) return; if (handle) { handle(req, res); return; } res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ name })); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await discovery.publish((server.address() as { port: number }).port);
    let stopped = false;
    const close = async () => { if (stopped) return; stopped = true; await discovery.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
    closers.push(close);
    return { server, close };
  };
  const client = new SharedServiceConnection(join(root, "selection.json"), registry);
  await client.initialize();
  return { root, client, start };
}
describe("desktop shared service", () => {
  it("discovers a real service, forwards JSON, and hides the credential", async () => {
    const { client, start } = await fixture(); await start("one");
    const status = await client.status();
    expect(status.connected).toBe(true); expect(JSON.stringify(status)).not.toContain('"token"');
    expect(JSON.parse((await client.json("/api/settings", "GET")).body)).toEqual({ name: "one" });
  });
  it("authenticates a loopback terminal and forwards only terminal messages", async () => {
    const { client, start } = await fixture();
    let desktopToken: string | undefined;
    const { server } = await start("terminal", (req, res) => {
      desktopToken = req.headers["x-agentroam-desktop-token"] as string;
      res.writeHead(200, { "content-type": "application/json" }).end('{"wsNonce":"terminal-nonce"}');
    });
    const websocket = new WebSocketServer({ noServer: true });
    closers.push(async () => {
      client.closeStreams();
      for (const socket of websocket.clients) socket.terminate();
      await new Promise<void>(resolve => websocket.close(() => resolve()));
    });
    let authorized = false;
    const received: Array<{ binary: boolean; bytes: number[] }> = [];
    server.on("upgrade", (req, socket, head) => {
      authorized = Boolean(desktopToken)
        && req.headers["x-agentroam-desktop-token"] === desktopToken
        && req.headers.origin === `http://${req.headers.host}`
        && req.url === "/ws?nonce=terminal-nonce";
      if (!authorized) { socket.destroy(); return; }
      websocket.handleUpgrade(req, socket, head, peer => {
        peer.on("message", (data: Buffer, binary) => received.push({ binary, bytes: [...data] }));
        peer.send(new Uint8Array([1, 2, 0, 0, 0, 1, 65]));
      });
    });
    const frames: TerminalSocketFrame[] = [];
    await client.openTerminal("split", frame => frames.push(frame));
    await vi.waitFor(() => expect(frames).toEqual([
      { type: "open" },
      { type: "data", data: new Uint8Array([1, 2, 0, 0, 0, 1, 65]) },
    ]));
    expect(authorized).toBe(true);
    const input = new Uint8Array([1, 1, 0, 0, 0, 1, 66]);
    const startRequest = '{"type":"term:start"}';
    client.sendTerminal("split", '{"type":"settings:update"}');
    client.sendTerminal("split", new Uint8Array([1, 4, 0, 0, 0, 1, 66]));
    client.sendTerminal("split", startRequest);
    client.sendTerminal("split", input);
    await vi.waitFor(() => expect(received).toEqual([
      { binary: false, bytes: [...Buffer.from(startRequest)] },
      { binary: true, bytes: [...input] },
    ]));
    client.stop("split");
    await vi.waitFor(() => expect(websocket.clients.size).toBe(0));
  });
  it("does not switch data sources after disconnect, but reconnects to the same data directory", async () => {
    const { client, start } = await fixture(); const first = await start("one"); await client.status();
    await start("two"); await first.close();
    expect((await client.status()).connected).toBe(false);
    await expect(client.json("/api/settings", "GET")).rejects.toThrow("未连接");
    await start("one"); expect((await client.status()).selected?.dataDir).toMatch(/one$/);
  });
  it("requires choosing between multiple services", async () => {
    const { client, start } = await fixture(); await start("one"); await start("two");
    const status = await client.status(); expect(status.connected).toBe(false);
    await client.select(status.choices[1].instanceId); expect((await client.status()).connected).toBe(true);
  });
  it("pins notification scope checks and reads to the same descriptor when the selected service changes", async () => {
    const { client, start } = await fixture();
    const calls: string[] = [];
    let releaseIdentity: (() => void) | undefined;
    await start("one", (req, res) => {
      calls.push(`one:${req.method}:${req.url}`);
      if (req.url === "/api/notifications") {
        releaseIdentity = () => { res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ serviceId: "scope-one", ownerId: "owner" })); };
      } else {
        let body = "";
        req.on("data", chunk => { body += chunk; });
        req.on("end", () => {
          expect(JSON.parse(body)).toEqual({ read: true });
          res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
        });
      }
    });
    await client.status();
    await start("two", (req, res) => { calls.push(`two:${req.method}:${req.url}`); res.writeHead(200).end("{}"); });
    const reading = client.readNotification("notice/one", { serviceId: "scope-one", ownerId: "owner" });
    await vi.waitFor(() => expect(releaseIdentity).toBeDefined());
    const other = (await client.status()).choices.find(item => item.dataDir.endsWith("two"))!;
    await client.select(other.instanceId);
    releaseIdentity!();
    await expect(reading).resolves.toEqual({ ok: true });
    expect(calls).toEqual(["one:GET:/api/notifications", "one:POST:/api/notifications/notice%2Fone/ack"]);
    expect((await client.status()).selected?.instanceId).toBe(other.instanceId);
  });
  it.each([{ serviceId: "wrong-service", ownerId: "owner" }, { serviceId: "service", ownerId: "wrong-owner" }])("rejects mismatched notification scope without posting (%j)", async expected => {
    const { client, start } = await fixture();
    const writes = vi.fn();
    await start("one", (req, res) => {
      if (req.method === "POST") writes();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ serviceId: "service", ownerId: "owner" }));
    });
    await client.status();
    await expect(client.readNotification("n", expected)).rejects.toThrow("Notification scope changed");
    expect(writes).not.toHaveBeenCalled();
    await expect(client.readNotification("n", undefined as never)).rejects.toThrow("Invalid notification read scope");
  });
  it("rejects non-loopback descriptors, redirects and API path escapes", () => {
    expect(validDescriptor({ protocol: 1, instanceId: "x", pid: 1, dataDir: "/data", token: "a".repeat(64), url: "http://example.com:3000" })).toBe(false);
    for (const path of ["https://evil.test/api/x", "//evil.test/api/x", "/api/../secret", "/api/\\evil"]) expect(() => serviceApiUrl("http://127.0.0.1:3001", path)).toThrow();
  });
  it("reads tunnel status without minting grants and uses its current origin over a stale URL file", async () => {
    const { root, client, start } = await fixture(); await start("one"); await client.status();
    await writeFile(join(root, "tunnel.url"), "http://192.168.1.10:3000/web");
    let grants = 0;
    let tunnel = { phase: "ready", mode: "public", provider: "cloudflare", accessUrl: "https://working.example/web" };
    let mesh = { phase: "ready", accessUrl: null as string | null };
    const request = vi.spyOn(client, "json").mockImplementation(async path => {
      if (path === "/api/mesh/status") return { status: 200, body: JSON.stringify(mesh) };
      if (path === "/api/desktop/tunnel") return { status: 200, body: JSON.stringify(tunnel) };
      if (path === "/api/pairing/admin/qr") return { status: 200, body: JSON.stringify({ grant: String(++grants).padStart(43, "g"), expiresAt: Date.now() + 300000 }) };
      throw new Error("Unexpected request");
    });
    await client.tunnelStatus(); await client.tunnelStatus();
    expect(grants).toBe(0);
    const publicQr = await client.mobilePairing();
    expect(publicQr.origin).toBe("https://working.example");
    expect(publicQr.pairingUrl).toContain("https://working.example/pair#pair=");
    tunnel = { phase: "error", mode: "lan", provider: "lan", accessUrl: "http://192.168.1.20:3000/web" };
    expect((await client.mobilePairing()).origin).toBe("http://192.168.1.20:3000");
    mesh = { phase: "joined", accessUrl: "http://my-computer.mesh.example" };
    expect((await client.mobilePairing()).pairingUrl).toMatch(/^http:\/\/my-computer\.mesh\.example\/pair#pair=/);
    tunnel = { phase: "ready", mode: "public", provider: "self-hosted", accessUrl: "https://desktop.connect.example/web" };
    expect((await client.mobilePairing()).pairingUrl).toMatch(/^https:\/\/desktop\.connect\.example\/pair#pair=/);
    expect(grants).toBe(4);
    request.mockRestore();
  });
  it("keeps pairing usable with an old backend but never substitutes a service restart", async () => {
    const { root, client, start } = await fixture(); await start("one"); await client.status();
    await writeFile(join(root, "tunnel.url"), "http://192.168.1.10:3000/web");
    const request = vi.spyOn(client, "json").mockImplementation(async path => path.startsWith("/api/desktop/tunnel")
      ? { status: 404, body: "Not Found" }
      : { status: 200, body: JSON.stringify({ grant: "g".repeat(43), expiresAt: Date.now() + 300000 }) });
    expect(await client.tunnelStatus()).toMatchObject({ phase: "unsupported", error: expect.stringContaining("升级") });
    expect(await client.connectTunnel()).toMatchObject({ phase: "unsupported" });
    expect((await client.mobilePairing()).origin).toBe("http://192.168.1.10:3000");
    expect(request.mock.calls.map(call => call[0]).every(path => path.startsWith("/api/desktop/tunnel") || path === "/api/pairing/admin/qr" || path === "/api/mesh/status")).toBe(true);
    request.mockRestore();
  });
});
