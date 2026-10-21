import { randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexDesktopTools } from "./codex-desktop-tools.js";
import { CodexDesktopContinuation } from "./codex-desktop-continuation.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(options: { cwd?: string; threadId?: string; sendError?: boolean; splitFrames?: boolean; dropSendAck?: boolean; lifecycle?: boolean } = {}) {
  const calls: any[] = []; const sockets = new Set<Socket>();
  let sent = false;
  const path = process.platform === "win32" ? `\\\\.\\pipe\\agentroam-desktop-test-${randomUUID()}` : join(tmpdir(), `desktop-${randomUUID()}.sock`);
  const server = createServer(socket => {
    sockets.add(socket); socket.on("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let data = Buffer.alloc(0);
    socket.on("data", chunk => {
      data = Buffer.concat([data, chunk]);
      while (data.length >= 4 && data.length >= data.readUInt32LE(0) + 4) {
        const length = data.readUInt32LE(0); const call = JSON.parse(data.subarray(4, length + 4).toString()); data = data.subarray(length + 4); calls.push(call);
        let result: unknown;
        if (call.method === "tools/list") result = { tools: [{ name: "read_thread", namespace: "codex_app" }, { name: "send_message_to_thread", namespace: "codex_app" }] };
        else if (call.params.tool === "read_thread") result = { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ thread: { id: options.threadId ?? "original", kind: "codex", cwd: options.cwd ?? process.cwd() }, turns: options.lifecycle && sent ? [{ id: "original-turn", status: "completed", items: [
          { id: "u1", type: "userMessage", content: [{ type: "text", text: "follow up" }] },
          { id: "a1", type: "agentMessage", phase: "final_answer", text: "continued" },
        ] }] : [] }) }] };
        else {
          sent = true;
          if (options.dropSendAck) { socket.destroy(); return; }
          result = { success: !options.sendError, contentItems: [{ type: "inputText", text: options.sendError ? "denied" : "sent" }] };
        }
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: call.id, result })); const frame = Buffer.alloc(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4);
        if (options.splitFrames) { socket.write(frame.subarray(0, 2)); setImmediate(() => socket.write(frame.subarray(2))); }
        else socket.write(frame);
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { path, calls };
}

describe("Codex Desktop app-tools transport", () => {
  it.each(["darwin", "linux"] as const)("never discovers or connects on %s, even with an explicit pipe", async platform => {
    const pipePaths = vi.fn();
    const tools = new CodexDesktopTools({ platform, environment: { CODEX_APP_TOOLS_PIPE_PATH: "/tmp/desktop.sock" }, pipePaths });
    expect(await tools.connect("original", process.cwd())).toBeNull();
    expect(pipePaths).not.toHaveBeenCalled();
  });

  it("uses the original thread on the local host and handles split frames", async () => {
    const { path, calls } = await fixture({ splitFrames: true });
    const connection = await new CodexDesktopTools({ platform: "win32", pipePaths: async () => [path], timeoutMs: 1000 }).connect("original", process.cwd());
    expect(connection).not.toBeNull();
    try { await connection!.send("human follow up", { callId: "run1" }); } finally { connection!.close(); }
    const send = calls.find(call => call.params?.tool === "send_message_to_thread");
    expect(send.params).toMatchObject({ threadId: "original", callId: "agentroam-run1", arguments: { threadId: "original", hostId: "local", prompt: "human follow up" } });
    expect(calls.some(call => /fork|start|archive/.test(call.params?.tool ?? ""))).toBe(false);
  });

  it.each([{ threadId: "different" }, { cwd: join(tmpdir(), "different-workspace") }])("refuses a different conversation or workspace: %j", async options => {
    const { path, calls } = await fixture(options);
    expect(await new CodexDesktopTools({ platform: "win32", pipePaths: async () => [path] }).connect("original", process.cwd())).toBeNull();
    expect(calls.some(call => call.params?.tool === "send_message_to_thread")).toBe(false);
  });

  it("does not retry a rejected write", async () => {
    const { path, calls } = await fixture({ sendError: true });
    const connection = await new CodexDesktopTools({ platform: "win32", pipePaths: async () => [path] }).connect("original", process.cwd());
    try { await expect(connection!.send("follow up")).rejects.toThrow("denied"); } finally { connection!.close(); }
    expect(calls.filter(call => call.params?.tool === "send_message_to_thread")).toHaveLength(1);
  });

  it("reports uncertain delivery once when Desktop accepts a write then disconnects", async () => {
    const { path, calls } = await fixture({ dropSendAck: true });
    const connection = await new CodexDesktopTools({ platform: "win32", pipePaths: async () => [path], timeoutMs: 1000 }).connect("original", process.cwd());
    const events = [];
    for await (const event of new CodexDesktopContinuation(connection!, 0).run("follow up")) events.push(event);
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "DESKTOP_DELIVERY_UNCONFIRMED" })]);
    expect(calls.filter(call => call.params?.tool === "send_message_to_thread")).toHaveLength(1);
  });

  it("follows a delivered prompt through the framed transport to original-thread completion", async () => {
    const { path, calls } = await fixture({ lifecycle: true, splitFrames: true });
    const connection = await new CodexDesktopTools({ platform: "win32", pipePaths: async () => [path], timeoutMs: 1000 }).connect("original", process.cwd());
    const events = [];
    for await (const event of new CodexDesktopContinuation(connection!, 0).run("follow up")) events.push(event);
    expect(events.at(-1)).toEqual({ type: "done", finalText: "continued", forkPoint: { turnId: "original-turn" } });
    expect(calls.filter(call => call.params?.tool === "send_message_to_thread")).toHaveLength(1);
    expect(calls.every(call => call.method === "tools/list" || ["read_thread", "send_message_to_thread"].includes(call.params.tool))).toBe(true);
  });

  it("allows disabling the bridge and treats an absent Desktop as unavailable", async () => {
    expect(await new CodexDesktopTools({ platform: "win32", environment: { AGENT_CODEX_DESKTOP_BRIDGE: "0" }, pipePaths: () => { throw new Error("must not discover"); } }).connect("original", process.cwd())).toBeNull();
    expect(await new CodexDesktopTools({ platform: "win32", pipePaths: async () => [] }).connect("original", process.cwd())).toBeNull();
  });
});
