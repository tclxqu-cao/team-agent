import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
// @ts-expect-error gateway ESM
import { WindowsSystemBridge } from "./windows-system-bridge.mjs";

function connection(reply: Record<string, unknown> | null) {
  const socket = new EventEmitter() as EventEmitter & {
    written: string;
    write: (data: string, callback: (error?: Error) => void) => void;
    destroy: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  socket.written = "";
  socket.destroy = vi.fn();
  socket.end = vi.fn();
  socket.write = (data, callback) => {
    socket.written += data;
    callback();
    queueMicrotask(() => {
      if (reply) socket.emit("data", Buffer.from(`${JSON.stringify(reply)}\n`));
      else socket.emit("end");
    });
  };
  return socket;
}

describe("WindowsSystemBridge", () => {
  it("normalizes a successful status probe and caches it", async () => {
    const socket = connection({ ok: true, locked: true, session: 3 });
    const connect = vi.fn(() => socket);
    const bridge = new WindowsSystemBridge({ platform: "win32", connect, probeTtlMs: 10_000 });
    await expect(bridge.probe()).resolves.toMatchObject({ available: true, locked: true, session: 3 });
    await expect(bridge.probe()).resolves.toMatchObject({ available: true, locked: true });
    expect(connect).toHaveBeenCalledOnce();
    expect(JSON.parse(socket.written.trim())).toEqual({ op: "status" });
  });

  it("forwards the password only in the unlock request and rejects service errors", async () => {
    const success = connection({ ok: true });
    const bridge = new WindowsSystemBridge({ platform: "win32", connect: () => success });
    await bridge.unlock("123456");
    expect(JSON.parse(success.written.trim())).toEqual({ op: "unlock", password: "123456" });

    const failed = new WindowsSystemBridge({ platform: "win32", connect: () => connection({ ok: false, error: "unlock-failed" }) });
    await expect(failed.unlock("bad")).rejects.toThrow("密码或 PIN");
    await expect(bridge.unlock("")).rejects.toThrow("1-256");
  });

  it("fails when the pipe closes before a response or the platform is unsupported", async () => {
    const closed = new WindowsSystemBridge({ platform: "win32", connect: () => connection(null) });
    await expect(closed.status()).rejects.toThrow("提前断开");
    const unsupported = new WindowsSystemBridge({ platform: "darwin", connect: () => connection({ ok: true }) });
    await expect(unsupported.status()).rejects.toThrow("仅支持 Windows");
  });
});
