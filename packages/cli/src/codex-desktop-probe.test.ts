import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { probeDesktopActivity, readDesktopActivity, withDesktopRpc } from "./codex-desktop-probe.js";

describe("complete Desktop activity snapshot", () => {
  it("checks all loaded-thread pages and every live status before declaring idle", async () => {
    const request = vi.fn(async (method, params) => {
      if (method === "thread/loaded/list") return params.cursor ? { data: ["two"], nextCursor: null } : { data: ["one"], nextCursor: "next" };
      return { thread: { id: params.threadId, status: { type: "idle" } } };
    });
    expect(await readDesktopActivity(request)).toEqual({ state: "idle" });
    expect(request).toHaveBeenCalledWith("thread/read", { threadId: "two", includeTurns: false });
    expect(request.mock.calls.filter(([method]) => method === "thread/loaded/list")).toHaveLength(4);
  });

  it("detects a busy thread after the first page, including pending approvals", async () => {
    const request = vi.fn(async (method, params) => {
      if (method === "thread/loaded/list") return params.cursor ? { data: ["two"], nextCursor: null } : { data: ["one"], nextCursor: "next" };
      return { thread: { id: params.threadId, status: { type: params.threadId === "two" ? "active" : "idle", activeFlags: ["waitingOnApproval"] } } };
    });
    expect(await readDesktopActivity(request)).toEqual({ state: "busy", activeCount: 1 });
  });

  it.each(["systemError", "notLoaded", "new-status"])("never assumes %s is idle", async (type) => {
    expect(await readDesktopActivity(async (method) => method === "thread/loaded/list"
      ? { data: ["one"], nextCursor: null } : { thread: { id: "one", status: { type } } })).toMatchObject({ state: "unknown" });
  });

  it("treats a newly loaded thread during inspection as unknown", async () => {
    let reads = 0;
    expect(await readDesktopActivity(async (method) => method === "thread/loaded/list"
      ? { data: ++reads === 1 ? [] : ["new"], nextCursor: null } : {})).toMatchObject({ state: "unknown" });
  });

  it.each([
    { data: ["one"], nextCursor: "loop" },
    { data: [42], nextCursor: null },
    { nextCursor: null },
  ])("rejects incomplete or nonterminating pagination", async (page) => {
    await expect(readDesktopActivity(async () => page)).rejects.toThrow();
  });

  it("does not declare idle when thread/read returns a different identity", async () => {
    await expect(readDesktopActivity(async (method) => method === "thread/loaded/list"
      ? { data: ["one"], nextCursor: null } : { thread: { id: "other", status: { type: "idle" } } })).rejects.toThrow("identity changed");
  });
});

describe("read-only Desktop RPC transport", () => {
  async function serverFixture(unix = false, ignoreRequests = false, rejectExtensions = false) {
    const root = unix ? await mkdtemp("/tmp/codex-desktop-probe-") : null;
    const http = createServer();
    const server = new WebSocketServer({ noServer: true });
    const extensionOffers: Array<string | string[] | undefined> = [];
    http.on("upgrade", (request, socket, head) => {
      const extensions = request.headers["sec-websocket-extensions"];
      extensionOffers.push(extensions);
      if (rejectExtensions && extensions) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      server.handleUpgrade(request, socket, head, (connection) => server.emit("connection", connection, request));
    });
    const methods: string[] = [];
    let closed = false;
    server.on("connection", (socket) => {
      socket.on("close", () => { closed = true; });
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        methods.push(message.method);
        if (ignoreRequests || !message.id) return;
        socket.send(JSON.stringify({ id: message.id, result: message.method === "thread/loaded/list" ? { data: [], nextCursor: null } : {} }));
      });
    });
    await new Promise<void>((done) => unix ? http.listen(join(root!, "rpc.sock"), done) : http.listen(0, "127.0.0.1", done));
    const endpoint = unix ? `ws+unix://localhost${root}/rpc.sock:/rpc` : `ws://127.0.0.1:${(http.address() as { port: number }).port}`;
    return { endpoint, methods, extensionOffers, isClosed: () => closed, async dispose() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((done) => server.close(() => done()));
      await new Promise<void>((done) => http.close(() => done()));
      if (root) await rm(root, { recursive: true, force: true });
    } };
  }

  it.each([false, true])("queries through TCP/Unix (%s) without business RPCs", async (unix) => {
    const fixture = await serverFixture(unix);
    try {
      expect(await probeDesktopActivity(fixture.endpoint)).toEqual({ state: "idle" });
      expect(fixture.methods).toEqual(["initialize", "initialized", "thread/loaded/list", "thread/loaded/list"]);
      await vi.waitFor(() => expect(fixture.isClosed()).toBe(true));
    } finally { await fixture.dispose(); }
  });

  it.each([false, true])("connects to a legacy TCP/Unix (%s) backend that rejects extension offers", async (unix) => {
    const fixture = await serverFixture(unix, false, true);
    try {
      expect(await probeDesktopActivity(fixture.endpoint)).toEqual({ state: "idle" });
      expect(fixture.extensionOffers).toEqual([undefined]);
      expect(fixture.methods).toEqual(["initialize", "initialized", "thread/loaded/list", "thread/loaded/list"]);
    } finally { await fixture.dispose(); }
  });

  it("preserves the socket error when a Unix endpoint is missing", async () => {
    const root = await mkdtemp("/tmp/codex-probe-missing-");
    try {
      await expect(withDesktopRpc(`ws+unix://localhost${root}/missing.sock:/rpc`, async () => {}))
        .rejects.toThrow(/Desktop probe connection failed:.*ENOENT/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("bounds a stuck RPC and disconnects only its own probe", async () => {
    const fixture = await serverFixture(false, true);
    try {
      expect(await probeDesktopActivity(fixture.endpoint, 100)).toMatchObject({ state: "unknown" });
      await vi.waitFor(() => expect(fixture.isClosed()).toBe(true));
    } finally { await fixture.dispose(); }
  });
});
