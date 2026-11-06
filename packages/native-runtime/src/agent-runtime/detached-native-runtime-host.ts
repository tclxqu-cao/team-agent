import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { resolveNativeRuntimeSocketPath } from "./native-runtime-broker.js";
import { RuntimeSessionError } from "./types.js";

export interface DetachedNativeRuntimeHostOptions {
  directory: string;
  codexExecutable?: string;
  opencodeExecutable?: string;
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
  host = new runtime.NativeRuntimeBrokerHost(config.directory, callbacks =>
    runtime.createNativeRuntimeBrokerHostRuntime(config.codexExecutable, callbacks, config.opencodeExecutable));
  await host.start();
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

function hostPid(directory: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(resolveNativeRuntimeSocketPath(directory));
    let buffer = "";
    const finish = (error?: Error, pid?: number) => {
      socket.destroy();
      if (error) reject(error);
      else resolve(pid!);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(500, () => finish(new Error("Native runtime host readiness timed out")));
    socket.once("error", error => finish(error));
    socket.once("end", () => finish(new Error("Native runtime host closed before readiness")));
    socket.once("connect", () => socket.write(JSON.stringify({ id: "readiness", method: "ping", params: {} }) + "\n"));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      try {
        const response = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        if (!response.ok || !Number.isSafeInteger(response.result?.pid) || response.result.pid <= 0) {
          throw new Error("Native runtime host returned invalid readiness");
        }
        finish(undefined, response.result.pid);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

/** Detached stdio and a stable cwd let native processes outlive a Web restart. */
export async function startDetachedNativeRuntimeHost(options: DetachedNativeRuntimeHostOptions): Promise<number> {
  try { return await hostPid(options.directory); } catch { /* Start only when no host answers. */ }
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
    let pid: number | undefined;
    try { pid = await hostPid(options.directory); } catch { /* A startup contender may still be listening. */ }
    if (pid) {
      if (pid !== child.pid && exitCode === undefined) {
        // Another process won. Reap our unused contender before returning so
        // it cannot become a second host during a later shutdown of the winner.
        child.kill("SIGTERM");
        await childExit;
      }
      return pid;
    }
    await delay(50);
  }
  throw new RuntimeSessionError(
    `Native runtime host failed to start${startupError ? ": " + startupError.message : ""}. See ${logPath}`,
    "RUNTIME_UNAVAILABLE",
  );
}
