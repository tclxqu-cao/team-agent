import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { Socket } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { CodexAppServerClient, type CodexAppServerClientOptions } from "./codex-app-server-client.js";

interface RpcRequest { id?: number; method: string; params?: unknown }

const clients: CodexAppServerClient[] = [];
const servers: Array<{ http: Server; ws: WebSocketServer; tcpSockets: Set<Socket> }> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
  for (const server of servers.splice(0)) {
    for (const socket of server.ws.clients) socket.terminate();
    for (const socket of server.tcpSockets) socket.destroy();
    await new Promise<void>((resolve) => server.ws.close(() => resolve()));
    await new Promise<void>((resolve) => server.http.close(() => resolve()));
  }
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function clientFor(options: CodexAppServerClientOptions) {
  const client = new CodexAppServerClient({ requestTimeoutMs: 1000, startupTimeoutMs: 200, ...options });
  clients.push(client);
  return client;
}

async function desktopServer(options: {
  socketPath?: string;
  handler?: (request: RpcRequest, socket: WebSocket) => boolean | void;
} = {}) {
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  const tcpSockets = new Set<Socket>();
  http.on("connection", (socket) => {
    tcpSockets.add(socket);
    socket.once("close", () => tcpSockets.delete(socket));
  });
  servers.push({ http, ws, tcpSockets });
  const requests: RpcRequest[] = [];
  const sockets: WebSocket[] = [];
  ws.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as RpcRequest;
      requests.push(request);
      if (options.handler?.(request, socket)) return;
      if (request.method === "initialize") socket.send(JSON.stringify({ id: request.id, result: {} }));
      if (request.method === "thread/list") socket.send(JSON.stringify({ id: request.id, result: { data: [] } }));
    });
  });
  await new Promise<void>((resolve) => {
    if (options.socketPath) http.listen(options.socketPath, resolve);
    else http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  const endpoint = { webSocketUrl: options.socketPath
    ? `ws+unix://localhost${encodeURI(options.socketPath)}:/rpc`
    : `ws://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/rpc` };
  return { endpoint, requests, sockets, ws };
}

function fallbackSpawner() {
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid: 4242, killed: false, killSignals: [] as string[],
    kill(signal = "SIGTERM") {
      this.killed = true;
      this.killSignals.push(signal);
      queueMicrotask(() => emitter.emit("exit", 0, signal));
      return true;
    },
  });
  child.stdin.on("data", (data) => {
    const request = JSON.parse(data.toString().trim()) as RpcRequest;
    if (request.id !== undefined) {
      child.stdout.write(`${JSON.stringify({ id: request.id, result: request.method === "thread/list" ? { data: [] } : {} })}\n`);
    }
  });
  const spawnProcess = vi.fn((_command: string, args: readonly string[]) => {
    if (args.join(" ") === "app-server daemon start") throw new Error("daemon unavailable");
    if (args.join(" ") !== "app-server --stdio") throw new Error(`Unexpected child: ${args.join(" ")}`);
    return child;
  });
  return { spawnProcess, child };
}

describe("Desktop-first Codex transport", () => {
  it("initializes Desktop directly and never launches daemon or standalone", async () => {
    const server = await desktopServer();
    const spawnProcess = vi.fn();
    const client = clientFor({ resolveDesktopEndpoint: async () => server.endpoint, spawnProcess: spawnProcess as never });
    await expect(client.request("thread/list", {})).resolves.toEqual({ data: [] });
    expect(client.mode).toBe("desktop");
    expect(client.pid).toBeUndefined();
    expect(server.requests.map(({ method }) => method)).toEqual(["initialize", "initialized", "thread/list"]);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("connects to a named Unix socket whose path contains spaces", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-desktop-"));
    directories.push(directory);
    const server = await desktopServer({ socketPath: join(directory, "Desktop socket.sock") });
    const client = clientFor({ environment: { AGENT_CODEX_DESKTOP_WS_URL: server.endpoint.webSocketUrl } });
    await expect(client.request("thread/list", {})).resolves.toEqual({ data: [] });
    expect(client.mode).toBe("desktop");
  });

  it.each(["unavailable", "invalid override", "handshake failure", "handshake timeout", "initialize failure", "initialize timeout"])(
    "tries shared then standalone after Desktop %s", async (failure) => {
      const fallback = fallbackSpawner();
      const server = await desktopServer({ handler: (request, socket) => {
        if (request.method !== "initialize") return;
        if (failure === "initialize failure") {
          socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "incompatible initialization" } }));
          return true;
        }
        if (failure === "initialize timeout") return true;
      } });
      const resolveDesktopEndpoint = vi.fn(async () => {
        if (failure === "unavailable") return null;
        if (failure === "handshake failure") return { webSocketUrl: `${server.endpoint.webSocketUrl}/wrong` };
        return server.endpoint;
      });
      // Reject the HTTP upgrade before initialization, while keeping the
      // backend alive and available to another connection.
      if (failure === "handshake failure") server.ws.options.verifyClient = () => false;
      if (failure === "handshake timeout") server.ws.options.verifyClient = (_info, _callback) => undefined;
      const client = clientFor({
        spawnProcess: fallback.spawnProcess as never,
        startupTimeoutMs: 30,
        ...(failure === "invalid override"
          ? { environment: { AGENT_CODEX_DESKTOP_WS_URL: "ws://external.example:4500" } }
          : { resolveDesktopEndpoint }),
      });
      await expect(client.request("thread/list", {})).resolves.toEqual({ data: [] });
      expect(client.mode).toBe("standalone");
      expect(fallback.spawnProcess.mock.calls.map(([, args]) => args)).toEqual([
        ["app-server", "daemon", "start"], ["app-server", "--stdio"],
      ]);
      if (failure !== "invalid override") expect(resolveDesktopEndpoint).toHaveBeenCalledOnce();
    },
  );

  it("does not switch transports or replay a business RPC rejected by Desktop", async () => {
    const server = await desktopServer({ handler: (request, socket) => {
      if (request.method !== "thread/resume") return;
      socket.send(JSON.stringify({ id: request.id, error: { code: -32000, message: "thread has an active writer" } }));
      return true;
    } });
    const spawnProcess = vi.fn();
    const client = clientFor({ resolveDesktopEndpoint: async () => server.endpoint, spawnProcess: spawnProcess as never });
    await expect(client.request("thread/resume", { threadId: "busy" })).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
    await expect(client.request("thread/list", {})).resolves.toEqual({ data: [] });
    expect(client.mode).toBe("desktop");
    expect(server.requests.filter(({ method }) => method === "thread/resume")).toHaveLength(1);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it.each(["dispose", "restart", "connection failure"])(
    "%s closes only this connection while another client's request continues", async (operation) => {
      const entered = deferred<void>();
      let completeOtherRequest!: () => void;
      const server = await desktopServer({ handler: (request, socket) => {
        if (request.method !== "thread/read") return;
        completeOtherRequest = () => socket.send(JSON.stringify({ id: request.id, result: { stillRunning: true } }));
        entered.resolve();
        return true;
      } });
      const spawnProcess = vi.fn();
      const resolveDesktopEndpoint = vi.fn(async () => server.endpoint);
      const client = clientFor({ resolveDesktopEndpoint, spawnProcess: spawnProcess as never });
      const other = clientFor({ resolveDesktopEndpoint: async () => server.endpoint, spawnProcess: spawnProcess as never });
      await client.request("thread/list", {});
      const otherRequest = other.request("thread/read", { threadId: "other-active-thread" });
      await entered.promise;
      if (operation === "dispose") await client.dispose();
      if (operation === "restart") await client.restart();
      if (operation === "connection failure") {
        const exited = deferred<void>();
        client.onExit(() => exited.resolve());
        server.sockets[0]!.terminate();
        await exited.promise;
      }
      completeOtherRequest();
      await expect(otherRequest).resolves.toEqual({ stillRunning: true });
      await expect(other.request("thread/list", {})).resolves.toEqual({ data: [] });
      expect(other.mode).toBe("desktop");
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(resolveDesktopEndpoint).toHaveBeenCalledTimes(operation === "restart" ? 2 : 1);
    },
  );

  it("rejects a pending business RPC on disconnect without submitting it to fallback", async () => {
    const server = await desktopServer({ handler: (request, socket) => {
      if (request.method !== "turn/start") return;
      socket.terminate();
      return true;
    } });
    const spawnProcess = vi.fn();
    const client = clientFor({ resolveDesktopEndpoint: async () => server.endpoint, spawnProcess: spawnProcess as never });
    await expect(client.request("turn/start", { threadId: "active" })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(server.requests.filter(({ method }) => method === "turn/start")).toHaveLength(1);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(client.mode).toBeNull();
  });

  it("re-probes Desktop on restart after standalone fallback", async () => {
    const fallback = fallbackSpawner();
    const server = await desktopServer();
    const resolveDesktopEndpoint = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(server.endpoint);
    const client = clientFor({ resolveDesktopEndpoint, spawnProcess: fallback.spawnProcess as never });
    await client.request("thread/list", {});
    expect(client.mode).toBe("standalone");
    await client.restart();
    expect(client.mode).toBe("desktop");
    expect(fallback.child.killSignals).toEqual(["SIGTERM"]);
    expect(resolveDesktopEndpoint).toHaveBeenCalledTimes(2);
    expect(fallback.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("does not attach or launch fallback when disposed during Desktop discovery", async () => {
    const discovery = deferred<null>();
    const entered = deferred<void>();
    const spawnProcess = vi.fn();
    const client = clientFor({ resolveDesktopEndpoint: () => {
      entered.resolve();
      return discovery.promise;
    }, spawnProcess: spawnProcess as never });
    const request = client.request("thread/list", {});
    const rejected = expect(request).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await entered.promise;
    await client.dispose();
    discovery.resolve(null);
    await rejected;
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(client.mode).toBeNull();
  });
});
