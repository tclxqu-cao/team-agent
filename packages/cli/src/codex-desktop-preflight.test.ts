import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { describe, expect, it, vi } from "vitest";
import { preflightCodexDesktop } from "./codex-desktop-preflight.js";

describe("shared backend configuration admission", () => {
  async function fixture(options: {
    broken?: boolean; status?: string; gatewayUnsupported?: boolean; gatewayBroken?: boolean;
    gatewayError?: { code: number; message: string }; activateOnSecondScan?: boolean;
  } = {}) {
    const http = createServer();
    const server = new WebSocketServer({ server: http });
    const methods: string[] = [];
    let broken = options.broken ?? false;
    let scans = 0;
    server.on("connection", socket => socket.on("message", raw => {
      const message = JSON.parse(String(raw)); methods.push(message.method);
      if (!message.id) return;
      let result: unknown = {};
      let error: { code: number; message: string } | undefined;
      if (message.method === "config/read" && broken || message.method === "account/gatewayOAuth/read" && options.gatewayBroken) {
        error = { code: -32603, message: "No such file or directory (os error 2)" };
      } else if (message.method === "account/gatewayOAuth/read" && options.gatewayError) {
        error = options.gatewayError;
      } else if (message.method === "account/gatewayOAuth/read" && options.gatewayUnsupported) {
        error = { code: -32601, message: "Method not found" };
      } else if (message.method === "thread/loaded/list") {
        scans++; result = { data: ["one"], nextCursor: null };
      } else if (message.method === "thread/read") {
        result = { thread: { id: "one", status: { type: options.activateOnSecondScan && scans >= 3 ? "active" : options.status ?? "idle" } } };
      }
      socket.send(JSON.stringify({ id: message.id, ...(error ? { error } : { result }) }));
    }));
    await new Promise<void>(done => http.listen(0, "127.0.0.1", done));
    return { endpoint: `ws://127.0.0.1:${(http.address() as { port: number }).port}`,
      methods, restart: vi.fn(async () => { broken = false; }),
      async close() { for (const socket of server.clients) socket.terminate();
        await new Promise<void>(done => server.close(() => done()));
        await new Promise<void>(done => http.close(() => done())); }
    };
  }

  it.each([false, true])("accepts a healthy backend and tolerates an absent legacy gateway method (%s)", async gatewayUnsupported => {
    const f = await fixture({ gatewayUnsupported });
    try {
      await preflightCodexDesktop(f.endpoint, "/unused", { restart: f.restart, log: () => {} });
      expect(f.restart).not.toHaveBeenCalled();
      expect(f.methods).toEqual(["initialize", "initialized", "config/read", "account/gatewayOAuth/read"]);
    } finally { await f.close(); }
  });

  it("accepts the unknown-variant response from a legacy Codex backend", async () => {
    const f = await fixture({ gatewayError: {
      code: -32600,
      message: "Invalid request: unknown variant `account/gatewayOAuth/read`, expected one of `initialize`, `config/read`",
    } });
    try {
      await preflightCodexDesktop(f.endpoint, "/unused", { restart: f.restart, log: () => {} });
      expect(f.restart).not.toHaveBeenCalled();
      expect(f.methods).toEqual(["initialize", "initialized", "config/read", "account/gatewayOAuth/read"]);
    } finally { await f.close(); }
  });

  it.each([
    { code: -32600, message: "Invalid request: missing field `workspaceId`" },
    { code: -32600, message: "Invalid request: unknown variant `config/read`, expected one of `initialize`" },
    { code: -32600, message: "Not authorized to read gateway configuration" },
    { code: -32603, message: "Permission denied" },
  ])("rejects a real gateway failure: $message", async (gatewayError) => {
    const f = await fixture({ gatewayError });
    try {
      await expect(preflightCodexDesktop(f.endpoint, "/unused", { restart: f.restart, log: () => {} }))
        .rejects.toThrow(gatewayError.message);
      expect(f.restart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("repairs an idle missing-directory daemon and verifies its gateway before switching Desktop", async () => {
    const f = await fixture({ broken: true });
    try {
      await preflightCodexDesktop(f.endpoint, "/unused", { restart: f.restart, log: () => {} });
      expect(f.restart).toHaveBeenCalledTimes(1);
      expect(f.methods.filter(method => method === "thread/read")).toHaveLength(2);
      expect(f.methods.at(-1)).toBe("account/gatewayOAuth/read");
      expect(f.methods.some(method => /resume|turn\/start|interrupt/.test(method))).toBe(false);
    } finally { await f.close(); }
  });

  it.each(["active", "systemError", "notLoaded"])("does not restart a broken daemon with %s tasks", async status => {
    const f = await fixture({ broken: true, status });
    try {
      await expect(preflightCodexDesktop(f.endpoint, "/unused", { restart: f.restart })).rejects.toThrow("已保留");
      expect(f.restart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("preserves a daemon when work begins between the two idle inspections", async () => {
    const f = await fixture({ broken: true, activateOnSecondScan: true });
    try {
      await expect(preflightCodexDesktop(f.endpoint, "/unused", { restart: f.restart })).rejects.toThrow("已保留");
      expect(f.restart).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });

  it("rejects a gateway that is still broken after one restart", async () => {
    const f = await fixture({ gatewayBroken: true });
    try {
      await expect(preflightCodexDesktop(f.endpoint, "/unused", { restart: f.restart, log: () => {} })).rejects.toThrow("仍无法读取配置");
      expect(f.restart).toHaveBeenCalledTimes(1);
    } finally { await f.close(); }
  });
});
