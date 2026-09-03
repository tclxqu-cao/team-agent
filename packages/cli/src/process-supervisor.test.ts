import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { ProcessSupervisor } from "./process-supervisor.js";

function fakeChild(pid = 42): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, { pid, exitCode: null, kill: vi.fn(() => true) });
  return child;
}

describe("ProcessSupervisor", () => {
  it("falls back to child.kill when taskkill cannot start", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit("error", new Error("ENOENT")));
      return killer;
    });
    const supervisor = new ProcessSupervisor("win32", spawnProcess as never);

    const stopping = supervisor.stop(child, 20);
    queueMicrotask(() => {
      Object.assign(child, { exitCode: 0 });
      child.emit("exit", 0, null);
    });
    await stopping;

    expect(spawnProcess).toHaveBeenCalledWith("taskkill", ["/PID", "42", "/T", "/F"], { stdio: "ignore" });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("uses taskkill for a running Windows process tree", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      const killer = new EventEmitter();
      queueMicrotask(() => {
        killer.emit("exit", 0, null);
        Object.assign(child, { exitCode: 0 });
        child.emit("exit", 0, null);
      });
      return killer;
    });
    const supervisor = new ProcessSupervisor("win32", spawnProcess as never);

    await supervisor.stop(child, 20);

    expect(child.kill).not.toHaveBeenCalled();
  });
});
