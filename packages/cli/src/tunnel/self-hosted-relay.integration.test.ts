import { once } from "node:events";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, request, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, createWebSocketStream } from "ws";
import { createRelay } from "../../../../deploy/https-relay/relay.mjs";
import { createDevicePairingGateway } from "../../../server/lib/device-pairing-gateway.mjs";
import { SelfHostedTunnelProvider } from "./self-hosted-provider.js";

const root = "https://connect.example.test";
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), "agentroam-self-hosted-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function serveDesktop(name: string) {
  const dataDir = await temporaryDirectory();
  const auth = createDevicePairingGateway({
    dataDir, desktop: { authenticate: () => false }, owner: { userId: name, username: name }, consoleStore: {}, trustProxy: true,
  });
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer((req, res) => {
    void auth.handle(req, res).then(handled => {
      if (handled) return;
      if (req.url === "/api/sessions?stream=1") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: ready\n\n");
      } else {
        res.end(name);
      }
    });
  });
  server.on("upgrade", (req, socket, head) => {
    if (!auth.authenticateUpgrade(req)) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(req, socket, head, ws => ws.send(name));
  });
  const port = await listen(server);
  cleanup.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    auth.store.close();
  });
  return { url: `http://127.0.0.1:${port}`, dataDir, auth };
}

function phoneRequest(relayPort: number, origin: URL, path: string, options: {
  headers?: Record<string, string>; body?: string; firstChunk?: boolean;
} = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({
      hostname: "127.0.0.1", port: relayPort, path, method: options.body ? "POST" : "GET",
      headers: { host: origin.host, ...options.headers }, signal: AbortSignal.timeout(5000),
    }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("error", reject);
      res.on("data", chunk => {
        body += chunk;
        if (options.firstChunk) {
          resolve({ status: res.statusCode!, headers: res.headers, body });
          res.destroy();
        }
      });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}

describe("self-hosted HTTPS pairing", () => {
  it("routes HTTP, one-use QR authorization, SSE and WebSocket to the original installation", async () => {
    const relay = createRelay({ publicOrigin: root, websocket: { WebSocketServer, createWebSocketStream } });
    const port = await listen(relay.server);
    cleanup.push(() => relay.close());
    const dial = (url: URL, options: WebSocket.ClientOptions) => new WebSocket(
      `ws://127.0.0.1:${port}${url.pathname}${url.search}`,
      { ...options, headers: { ...options.headers, host: url.host } },
    );
    const a = await serveDesktop("desktop-a");
    const b = await serveDesktop("desktop-b");
    const start = (desktop: Awaited<ReturnType<typeof serveDesktop>>) =>
      new SelfHostedTunnelProvider(root, desktop.dataDir, dial).start({ localUrl: desktop.url, signal: AbortSignal.timeout(10_000) });
    const first = await start(a);
    cleanup.push(first.close);
    const second = await start(b);
    cleanup.push(second.close);
    const origin = new URL(first.publicUrl);
    const other = new URL(second.publicUrl);
    expect(origin.host).not.toBe(other.host);
    if (process.platform !== "win32") expect((await stat(join(a.dataDir, "relay", "identity"))).mode & 0o777).toBe(0o600);

    expect((await phoneRequest(port, origin, "/api/sessions")).status).toBe(401);
    expect((await phoneRequest(port, origin, "/api/internal/todo-mcp")).status).toBe(404);
    expect((await phoneRequest(port, origin, "/api/../api/desktop/identity")).status).toBe(404);
    expect((await phoneRequest(port, origin, "/api/session", { headers: { "x-agentroam-device-id": "spoofed" } })).status).toBe(401);
    const { grant } = a.auth.store.createQr();
    const exchange = (target: URL) => phoneRequest(port, target, "/api/pairing/qr-exchange", {
      headers: { origin: target.origin, "content-type": "application/json" },
      body: JSON.stringify({ grant, name: "My phone" }),
    });
    expect((await exchange(other)).status).toBe(410);
    const paired = await exchange(origin);
    expect(paired.status).toBe(200);
    expect((await exchange(origin)).status).toBe(410);
    const setCookie = paired.headers["set-cookie"]?.[0] ?? "";
    expect(setCookie).toMatch(/^__Host-agentroam_device_session=.*; Path=\/; Secure/i);
    const cookie = setCookie.split(";")[0];
    const headers = { cookie, origin: origin.origin };
    expect((await phoneRequest(port, origin, "/api/sessions", { headers })).body).toBe("desktop-a");
    expect((await phoneRequest(port, other, "/api/sessions", { headers: { cookie } })).status).toBe(401);
    expect((await phoneRequest(port, origin, "/api/sessions", { headers: { cookie: cookie.slice(7) } })).status).toBe(401);

    const sse = await phoneRequest(port, origin, "/api/sessions?stream=1", { headers, firstChunk: true });
    expect(sse.body).toBe("data: ready\n\n");
    const device = JSON.parse(paired.body).device;
    const nonce = a.auth.store.issueNonce(device.id);
    const phone = dial(new URL(`wss://${origin.host}/ws?nonce=${nonce}`), {
      headers, handshakeTimeout: 5000,
    });
    try {
      expect(String((await once(phone, "message"))[0])).toBe("desktop-a");
    } finally { phone.terminate(); }

    await first.close();
    const restarted = await start(a);
    cleanup.push(restarted.close);
    expect(restarted.publicUrl).toBe(first.publicUrl);
    expect((await phoneRequest(port, origin, "/api/sessions", { headers })).body).toBe("desktop-a");
  }, 15_000);
});
