import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { probeDesktopActivity, readDesktopActivity } from "./codex-desktop-probe.js";

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
  async function serverFixture(unix = false, ignoreRequests = false) {
    const root = unix ? await mkdtemp("/tmp/codex-desktop-probe-") : null;
    const http = createServer();
    const server = new WebSocketServer({ server: http });
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
    return { endpoint, methods, isClosed: () => closed, async dispose() {
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

  it("bounds a stuck RPC and disconnects only its own probe", async () => {
    const fixture = await serverFixture(false, true);
    try {
      expect(await probeDesktopActivity(fixture.endpoint, 100)).toMatchObject({ state: "unknown" });
      await vi.waitFor(() => expect(fixture.isClosed()).toBe(true));
    } finally { await fixture.dispose(); }
  });
});
