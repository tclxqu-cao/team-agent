import { spawn, type ChildProcess } from "node:child_process";

type SpawnProcess = typeof spawn;

export interface SleepInhibitor {
  lost: Promise<Error>;
  release(): Promise<void>;
}

export interface SleepInhibitorOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  spawnProcess?: SpawnProcess;
  readyTimeoutMs?: number;
  stopTimeoutMs?: number;
}

export async function acquireSleepInhibitor(options: SleepInhibitorOptions = {}): Promise<SleepInhibitor> {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const spawnProcess = options.spawnProcess ?? spawn;
  const readyTimeoutMs = options.readyTimeoutMs ?? 5_000;
  const stopTimeoutMs = options.stopTimeoutMs ?? 2_000;

  if (platform === "darwin") {
    const child = spawnProcess("/usr/bin/caffeinate", ["-i", "-w", String(pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
    await waitForSpawn(child, readyTimeoutMs, "macOS idle-sleep inhibitor");
    return monitorChild(child, stopTimeoutMs, "macOS idle-sleep inhibitor");
  }

  if (platform === "win32") {
    const script = buildWindowsSleepInhibitorScript(pid);
    const child = spawnProcess("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64"),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    await waitForReadyLine(child, readyTimeoutMs);
    return monitorChild(child, stopTimeoutMs, "Windows idle-sleep inhibitor");
  }

  throw new Error(`idle-sleep prevention is unsupported on ${platform}`);
}

export function buildWindowsSleepInhibitorScript(parentPid: number): string {
  return String.raw`
$ErrorActionPreference = "Stop"
$source = @'
using System;
using System.Runtime.InteropServices;
public static class AgentRoamPower {
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint SetThreadExecutionState(uint esFlags);
}
'@
Add-Type -TypeDefinition $source
$continuous = [uint32]::Parse("80000000", [Globalization.NumberStyles]::HexNumber)
$systemRequired = [uint32]1
$result = [AgentRoamPower]::SetThreadExecutionState($continuous -bor $systemRequired)
if ($result -eq 0) { throw "SetThreadExecutionState failed" }
[Console]::Out.WriteLine("AGENTROAM_SLEEP_INHIBITOR_READY")
try {
  Wait-Process -Id ${parentPid}
} finally {
  [void][AgentRoamPower]::SetThreadExecutionState($continuous)
}
`;
}

function waitForSpawn(child: ChildProcess, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const timeout = setTimeout(() => finish(new Error(`${label} did not start within ${timeoutMs}ms`)), timeoutMs);
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`${label} exited before readiness (${formatExit(code, signal)})`));
    };
    const onSpawn = () => finish();
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("spawn", onSpawn);
      if (error) rejectReady(error);
      else resolveReady();
    };
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("spawn", onSpawn);
  });
}

function waitForReadyLine(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      finish(new Error(`Windows idle-sleep inhibitor did not become ready within ${timeoutMs}ms`));
    }, timeoutMs);
    const onStdout = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.includes("AGENTROAM_SLEEP_INHIBITOR_READY")) finish();
    };
    const onStderr = (chunk: Buffer | string) => { stderr += chunk.toString(); };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      const detail = stderr.trim();
      finish(new Error(`Windows idle-sleep inhibitor exited before readiness (${formatExit(code, signal)})${detail ? `: ${detail}` : ""}`));
    };
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      child.stdout?.removeListener("data", onStdout);
      child.stderr?.removeListener("data", onStderr);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      if (error) rejectReady(error);
      else resolveReady();
    };
    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

function monitorChild(child: ChildProcess, stopTimeoutMs: number, label: string): SleepInhibitor {
  let releasing = false;
  let released = false;
  let resolveLost!: (error: Error) => void;
  const lost = new Promise<Error>((resolvePromise) => { resolveLost = resolvePromise; });
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", (code, signal) => {
      if (!releasing) resolveLost(new Error(`${label} stopped unexpectedly (${formatExit(code, signal)})`));
      resolveExit();
    });
    child.once("error", (error) => {
      if (!releasing) resolveLost(error);
    });
  });

  return {
    lost,
    async release() {
      if (released) return;
      released = true;
      releasing = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
      await Promise.race([exited, delay(stopTimeoutMs)]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

function formatExit(code: number | null, signal: NodeJS.Signals | null): string {
  return signal ? `signal ${signal}` : `exit ${code ?? 1}`;
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, timeoutMs));
}
