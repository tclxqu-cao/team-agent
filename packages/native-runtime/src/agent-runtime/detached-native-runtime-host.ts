import { execFile, spawn } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { compareAgentRoamVersions, parseAgentRoamVersion } from "@agent/core";
import { resolveNativeRuntimeSocketPath } from "./native-runtime-broker.js";
import { RuntimeSessionError } from "./types.js";

export interface DetachedNativeRuntimeHostOptions {
  directory: string;
  codexExecutable?: string;
  opencodeExecutable?: string;
  /** A packaged gateway may replace an older broker before serving requests. */
  packageVersion?: string;
  /** The built distribution to load; defaults to this package's bundled entry. */
  moduleUrl?: string;
  timeoutMs?: number;
}

const BOOTSTRAP = `
import { openSync, writeFileSync, closeSync, readFileSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
const config = JSON.parse(process.argv[1]);
const lockPath = join(config.directory, "native-runtime-start.lock");
let lock;
for (let attempt = 0; attempt < 2; attempt++) {
  try {
    lock = openSync(lockPath, "wx", 0o600);
    writeFileSync(lock, String(process.pid));
    break;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let previous;
    try { previous = readFileSync(lockPath, "utf8"); } catch { continue; }
    const pid = Number(previous);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); process.exit(0); }
      catch (error) { if (error.code !== "ESRCH") process.exit(0); }
    } else if (Date.now() - statSync(lockPath).mtimeMs < 30000) process.exit(0);
    try { if (readFileSync(lockPath, "utf8") === previous) unlinkSync(lockPath); } catch {}
  }
}
if (lock === undefined) process.exit(0);
function releaseLock() {
  if (lock === undefined) return;
  closeSync(lock);
  lock = undefined;
  try { if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath); } catch {}
}
process.once("exit", releaseLock);
let host;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  try { if (host) await host.stop(); process.exit(0); }
  catch (error) { console.error(error); process.exit(1); }
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
try {
  const runtime = await import(config.moduleUrl);
  const startup = await runtime.prepareDetachedNativeRuntimeHost(config);
  if (startup === "reuse") process.exit(0);
  host = new runtime.NativeRuntimeBrokerHost(config.directory, callbacks =>
    runtime.createNativeRuntimeBrokerHostRuntime(config.codexExecutable, callbacks, config.opencodeExecutable),
    Date.now, config.packageVersion);
  await host.start({ endInterruptedGoals: startup === "replaced" });
  console.log(JSON.stringify({ event: "native-runtime-host.started", pid: process.pid, at: new Date().toISOString() }));
} catch (error) {
  if (host) await host.stop().catch(() => {});
  if (error.code === "EADDRINUSE") process.exit(0);
  console.error(error);
  process.exit(1);
} finally {
  releaseLock();
}
`;

type HostIdentity = { pid: number; packageVersion?: string };
type HostReply = { ok?: boolean; result?: unknown };

function requestHost(
  directory: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
): Promise<HostReply | null> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(resolveNativeRuntimeSocketPath(directory));
    const id = randomUUID();
    let buffer = "";
    const timer = setTimeout(() => finish(new Error("Native runtime host response timed out")), timeoutMs);
    const finish = (error?: Error, reply: HostReply | null = null) => {
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(reply);
    };
    socket.setEncoding("utf8");
    socket.once("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "ENOENT" || error.code === "ECONNREFUSED" ? undefined : error);
    });
    socket.once("end", () => finish(new Error("Native runtime host closed before replying")));
    socket.once("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (response?.id !== id) throw new Error("Native runtime host returned an unexpected response");
        finish(undefined, response);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

async function readHost(directory: string): Promise<HostIdentity | null> {
  const response = await requestHost(directory, "ping", {}, 500);
  if (!response) return null;
  const host = response.result as HostIdentity | undefined;
  if (!response.ok || !host || !Number.isSafeInteger(host.pid) || host.pid <= 1) {
    throw new Error("Native runtime host returned invalid readiness");
  }
  return host;
}

function canReuseHost(host: HostIdentity, packageVersion?: string): boolean {
  return !packageVersion || (
    typeof host.packageVersion === "string"
    && Boolean(parseAgentRoamVersion(host.packageVersion))
    && compareAgentRoamVersions(host.packageVersion, packageVersion) >= 0
  );
}

const runFile = promisify(execFile);
const processOptions = { timeout: 3_000, windowsHide: true };

async function readProcessIdentity(pid: number): Promise<string> {
  if (process.platform === "win32") {
    const { stdout } = await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object CommandLine,CreationDate | ConvertTo-Json -Compress`,
    ], processOptions);
    return stdout.trim();
  }
  const { stdout } = await runFile("ps", ["-ww", "-p", String(pid), "-o", "lstart=", "-o", "command="], processOptions);
  return stdout.trim();
}

function isDetachedBrokerProcess(identity: string, directory: string): boolean {
  const windows = process.platform === "win32";
  const command = windows ? (JSON.parse(identity || "null")?.CommandLine as string | undefined) : identity;
  if (!command?.includes("--input-type=module") || !command.includes("--eval")
    || !command.includes("native-runtime-start.lock") || !command.includes("createNativeRuntimeBrokerHostRuntime")) return false;
  const configPrefix = JSON.stringify({ directory }).slice(0, -1) + ",";
  if (!windows) return command.includes(configPrefix);
  const quotedPrefix = configPrefix.replace(/(\\*)"/g, (_, slashes: string) => slashes + slashes + '\\"');
  return command.toLowerCase().includes(quotedPrefix.toLowerCase());
}

async function interruptBrokerRuns(directory: string): Promise<void> {
  // Use the same persisted admission records for old hosts that have no
  // version handshake and new ones. External sessions never own these rows.
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(join(directory, ".agent-data", "agent.db"), { readOnly: true });
  let runs;
  try {
    runs = database.prepare("SELECT session_id, run_id FROM native_runtime_run WHERE status = 'active'").all();
  } finally {
    database.close();
  }
  await Promise.allSettled(runs.map(run => requestHost(directory, "abort", {
    sessionId: run.session_id, expectedRunId: run.run_id, source: "cli-upgrade",
  }, 1_500)));
}

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processExists(pid)) {
    if (Date.now() >= deadline) return false;
    await delay(50);
  }
  return true;
}

async function stopHostForUpgrade(directory: string, host: HostIdentity): Promise<void> {
  const identity = await readProcessIdentity(host.pid);
  if (!isDetachedBrokerProcess(identity, directory) || (await readHost(directory))?.pid !== host.pid) {
    throw new Error("Cannot verify the previous AgentRoam broker process");
  }
  await interruptBrokerRuns(directory).catch(error => console.warn("Could not interrupt turns before replacing the broker:", error));
  if (!processExists(host.pid)) return;
  if (await readProcessIdentity(host.pid) !== identity) throw new Error("AgentRoam broker process changed during upgrade");
  if (process.platform === "win32") {
    await runFile("taskkill.exe", ["/PID", String(host.pid), "/T", "/F"], processOptions);
  } else {
    process.kill(host.pid, "SIGTERM");
  }
  if (await waitForProcessExit(host.pid, 4_000)) return;
  if (process.platform !== "win32" && await readProcessIdentity(host.pid) === identity) {
    process.kill(host.pid, "SIGKILL");
    if (await waitForProcessExit(host.pid, 1_000)) return;
  }
  throw new Error("Previous AgentRoam broker did not exit");
}

/** Runs in the detached child while it holds the broker startup lock. */
export async function prepareDetachedNativeRuntimeHost({ directory, packageVersion }: DetachedNativeRuntimeHostOptions): Promise<"reuse" | "start" | "replaced"> {
  const existing = await readHost(directory);
  if (existing && canReuseHost(existing, packageVersion)) return "reuse";
  if (existing) await stopHostForUpgrade(directory, existing);
  if (process.platform !== "win32" && !await readHost(directory)) {
    const socketPath = resolveNativeRuntimeSocketPath(directory);
    // A hard stop can leave the Unix socket file behind. Only unlink a
    // socket under the startup lock after proving it has no listener.
    try {
      if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return existing ? "replaced" : "start";
}

/** Detached stdio and a stable cwd let native processes outlive a Web restart. */
export async function startDetachedNativeRuntimeHost(options: DetachedNativeRuntimeHostOptions): Promise<number> {
  if (options.packageVersion && !parseAgentRoamVersion(options.packageVersion)) {
    throw new Error("Invalid AgentRoam broker package version");
  }
  const current = await readHost(options.directory);
  if (current && canReuseHost(current, options.packageVersion)) return current.pid;
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const logPath = join(options.directory, "native-runtime-host.log");
  const log = openSync(logPath, "a", 0o600);
  let startupError: Error | undefined;
  let exitCode: number | null | undefined;
  let child: ReturnType<typeof spawn>;
  let childExit: Promise<void>;
  try {
    child = spawn(process.execPath, ["--input-type=module", "--eval", BOOTSTRAP, JSON.stringify({
      directory: options.directory,
      codexExecutable: options.codexExecutable,
      opencodeExecutable: options.opencodeExecutable,
      moduleUrl: options.moduleUrl ?? import.meta.url,
      packageVersion: options.packageVersion,
    })], {
      cwd: homedir(),
      detached: true,
      stdio: ["ignore", log, log],
      windowsHide: true,
    });
    child.once("error", error => { startupError = error; });
    childExit = new Promise(resolve => child.once("exit", code => { exitCode = code; resolve(); }));
    child.unref();
  } finally {
    closeSync(log);
  }
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  while (Date.now() < deadline) {
    if (startupError || (exitCode !== undefined && exitCode !== null && exitCode !== 0)) break;
    let host: HostIdentity | null = null;
    try { host = await readHost(options.directory); } catch { /* A startup contender may still be listening. */ }
    if (host && canReuseHost(host, options.packageVersion)) {
      if (host.pid !== child.pid && exitCode === undefined) {
        // Another process won. Reap our unused contender before returning so
        // it cannot become a second host during a later shutdown of the winner.
        child.kill("SIGTERM");
        await childExit;
      }
      return host.pid;
    }
    await delay(50);
  }
  throw new RuntimeSessionError(
    `Native runtime host failed to start${startupError ? ": " + startupError.message : ""}. See ${logPath}`,
    "RUNTIME_UNAVAILABLE",
  );
}
