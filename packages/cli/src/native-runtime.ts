import { chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const WINDOWS_PTY_PROBE = `
const pty = require(process.argv[1]);
const marker = "agentroam-runtime-probe";
const terminal = pty.spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", "echo " + marker], {
  name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
});
let output = "";
const timer = setTimeout(() => process.exit(1), 5000);
terminal.onData(chunk => { output = (output + chunk).slice(-4096); });
terminal.onExit(({ exitCode }) => {
  clearTimeout(timer);
  process.exit(exitCode === 0 && output.includes(marker) ? 0 : 1);
});
`;

export function probeSQLiteRuntime(runtimeRequire: NodeRequire): void {
  const Database = runtimeRequire("better-sqlite3");
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE runtime_probe (value INTEGER NOT NULL)");
    database.prepare("INSERT INTO runtime_probe VALUES (?)").run(7);
    if (database.prepare("SELECT value FROM runtime_probe").get()?.value !== 7) {
      throw new Error("SQLite runtime query failed");
    }
  } finally {
    database.close();
  }
}

export async function probeTerminalRuntime(runtimeRequire: NodeRequire, platform = process.platform): Promise<void> {
  if (platform === "win32") {
    // ConPTY retains an output worker after shell exit. Keep the probe in an
    // owned child process so terminating it releases all handles together.
    await execute(process.execPath, ["--input-type=commonjs", "-e", WINDOWS_PTY_PROBE, runtimeRequire.resolve("node-pty")], {
      timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
    });
    return;
  }
  const pty = runtimeRequire("node-pty");
  const marker = "agentroam-runtime-probe";
  const terminal = pty.spawn("/bin/sh", ["-c", `printf ${marker}`], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env,
  });
  await new Promise<void>((resolveProbe, rejectProbe) => {
    let output = "";
    const timer = setTimeout(() => {
      dataListener.dispose();
      exitListener.dispose();
      try { terminal.kill(); } catch {}
      rejectProbe(new Error("PTY runtime probe timed out"));
    }, 5_000);
    const dataListener = terminal.onData((chunk: string) => { output = (output + chunk).slice(-4096); });
    const exitListener = terminal.onExit(({ exitCode }: { exitCode: number }) => {
      clearTimeout(timer);
      dataListener.dispose();
      exitListener.dispose();
      if (exitCode === 0 && output.includes(marker)) resolveProbe();
      else rejectProbe(new Error(`PTY runtime probe failed (exit ${exitCode})`));
    });
  });
}

export async function repairNativeRuntimePermissions(
  runtimeRoot: string,
  platform = process.platform,
  arch = process.arch,
): Promise<void> {
  if (platform === "win32") return;
  const helper = resolve(runtimeRoot, "node_modules/node-pty/prebuilds", `${platform}-${arch}`, "spawn-helper");
  try {
    await chmod(helper, 0o755);
  } catch (error: any) {
    if (error?.code === "ENOENT") throw new Error(`node-pty spawn-helper missing: ${helper}`);
    throw new Error(`node-pty spawn-helper permission repair failed: ${error?.message ?? error}`);
  }
}
