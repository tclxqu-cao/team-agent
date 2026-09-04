import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { acquireSleepInhibitor, buildWindowsSleepInhibitorScript } from "./sleep-inhibitor.js";

interface FakeChild extends ChildProcess {
  stdout: PassThrough | null;
  stderr: PassThrough | null;
}

function fakeChild(withPipes = false): FakeChild {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    pid: 9001,
    exitCode: null,
    signalCode: null,
    stdout: withPipes ? new PassThrough() : null,
    stderr: withPipes ? new PassThrough() : null,
    kill: vi.fn((signal: NodeJS.Signals) => {
      Object.assign(child, { signalCode: signal });
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    }),
  });
  return child as FakeChild;
}

describe("sleep inhibitor", () => {
  it("uses caffeinate to prevent idle sleep without preventing display sleep", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });

    const inhibitor = await acquireSleepInhibitor({
      platform: "darwin",
      pid: 4321,
      spawnProcess: spawnProcess as never,
      readyTimeoutMs: 50,
      stopTimeoutMs: 50,
    });

    expect(spawnProcess).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-w", "4321"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const calls = spawnProcess.mock.calls as unknown as Array<[string, string[]]>;
    expect(calls[0][1]).not.toContain("-d");
    await inhibitor.release();
    await inhibitor.release();
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("uses only the Windows system-required execution state", async () => {
    const child = fakeChild(true);
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => {
        child.emit("spawn");
        child.stdout!.write("AGENTROAM_SLEEP_INHIBITOR_READY\n");
      });
      return child;
    });

    const inhibitor = await acquireSleepInhibitor({
      platform: "win32",
      pid: 7654,
      spawnProcess: spawnProcess as never,
      readyTimeoutMs: 50,
      stopTimeoutMs: 50,
    });
    const calls = spawnProcess.mock.calls as unknown as Array<[string, string[]]>;
    const args = calls[0][1];
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");

    expect(script).toContain("SetThreadExecutionState");
    expect(script).toContain("$systemRequired = [uint32]1");
    expect(script).toContain("Wait-Process -Id 7654");
    expect(script).not.toContain("ES_DISPLAY_REQUIRED");
    await inhibitor.release();
  });

  it("reports a helper that stops after acquisition", async () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const inhibitor = await acquireSleepInhibitor({
      platform: "darwin",
      spawnProcess: spawnProcess as never,
      readyTimeoutMs: 50,
    });

    Object.assign(child, { exitCode: 3 });
    child.emit("exit", 3, null);
    await expect(inhibitor.lost).resolves.toMatchObject({ message: expect.stringContaining("stopped unexpectedly") });
  });

  it("rejects unsupported platforms and early helper failures", async () => {
    await expect(acquireSleepInhibitor({ platform: "linux" })).rejects.toThrow("unsupported on linux");

    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("error", new Error("missing caffeinate")));
      return child;
    });
    await expect(acquireSleepInhibitor({
      platform: "darwin",
      spawnProcess: spawnProcess as never,
      readyTimeoutMs: 50,
    })).rejects.toThrow("missing caffeinate");
  });

  it("builds a Windows helper that clears its assertion in finally", () => {
    const script = buildWindowsSleepInhibitorScript(123);
    expect(script).toContain("$continuous -bor $systemRequired");
    expect(script).toContain("finally");
    expect(script).toContain("SetThreadExecutionState($continuous)");
  });
});
