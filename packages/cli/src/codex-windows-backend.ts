import { execFile } from "node:child_process";
import { readFile, mkdir, writeFile, rename, rm, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolveCodexRuntime } from "./codex-runtime-manager.js";
import { withDesktopRpc } from "./codex-desktop-probe.js";

const executeFile = promisify(execFile);
export const WINDOWS_CODEX_TASK = "AgentRoam-Codex-Shared";
export interface WindowsBackendConfig { version: 1; endpoint: string; executable: string; codexHome: string }
export function windowsBackendPath(home = homedir()): string { return join(home, ".agentroam", "codex-desktop", "windows-backend.json"); }
export function psLiteral(value: string): string { return `'${value.replaceAll("'", "''")}'`; }
export function quoteWindowsArgument(value: string): string { return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`; }
export function validateWindowsBackend(value: unknown): WindowsBackendConfig {
  const config = value as WindowsBackendConfig;
  const url = new URL(config.endpoint);
  if (config.version !== 1 || url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || !url.port
    || !/^\/[a-f0-9]{48}$/.test(url.pathname) || url.search || url.hash || url.username || url.password
    || !/^[A-Za-z]:\\.*\.exe$/i.test(config.executable) || !/^[A-Za-z]:\\/.test(config.codexHome)) throw new Error("Invalid Windows shared backend configuration");
  return config;
}
export async function readWindowsBackend(home = homedir()): Promise<WindowsBackendConfig | null> {
  try { return validateWindowsBackend(JSON.parse(await readFile(windowsBackendPath(home), "utf8"))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
interface BackendContext {
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
  execute?: typeof executeFile;
  resolveExecutable?: () => Promise<string>;
  probe?: (endpoint: string) => Promise<void>;
  allocatePort?: () => Promise<number>;
  wait?: () => Promise<void>;
}
export async function ensureWindowsBackend(dataDir: string, context: BackendContext = {}): Promise<WindowsBackendConfig> {
  const home = context.homeDir ?? homedir();
  const environment = context.environment ?? process.env;
  const path = windowsBackendPath(home), root = join(home, ".agentroam", "codex-desktop");
  const execute = context.execute ?? executeFile;
  const run = (script: string) => execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; ${script}`], { env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  await mkdir(root, { recursive: true });
  await run(`$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe ${psLiteral(root)} /inheritance:r /grant:r "\${sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'Cannot protect shared backend directory' }`);
  const lockPath = `${path}.lock`;
  let lock;
  for (let attempt = 0; attempt < 120; attempt++) {
    try { lock = await open(lockPath, "wx"); await lock.writeFile(String(process.pid)); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const owner = Number(await readFile(lockPath, "utf8"));
        const age = Date.now() - (await stat(lockPath)).mtimeMs;
        if (Number.isSafeInteger(owner) && owner > 1) {
          try { process.kill(owner, 0); } catch (probeError) {
            if ((probeError as NodeJS.ErrnoException).code === "ESRCH") await rm(lockPath, { force: true });
          }
        } else if (age > 30_000) await rm(lockPath, { force: true });
      } catch (readError) { if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!lock) throw new Error("Windows shared backend setup is busy; retry shortly");
  try {
    let config = await readWindowsBackend(home);
    const executable = await (context.resolveExecutable ?? (async () => environment.AGENT_CODEX_BIN || (await resolveCodexRuntime({ dataDir, target: "windows-amd64", platform: "win32", environment })).executable))();
    if (!config) {
      const port = await (context.allocatePort ?? (() => new Promise<number>((resolve, reject) => {
        const server = createServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); if (!address || typeof address === "string") { server.close(); reject(new Error("No loopback port")); return; } server.close(error => error ? reject(error) : resolve(address.port)); });
      })))();
      config = { version: 1, endpoint: `ws://127.0.0.1:${port}/${randomBytes(24).toString("hex")}`, executable, codexHome: environment.CODEX_HOME || join(home, ".codex") };
    } else config = { ...config, executable };
    validateWindowsBackend(config);
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600 }); await rename(temporary, path);
    const host = fileURLToPath(new URL("./codex-windows-backend-host.js", import.meta.url));
    const argumentsValue = `${quoteWindowsArgument(host)} ${quoteWindowsArgument(path)}`;
    await run(`$action=New-ScheduledTaskAction -Execute ${psLiteral(process.execPath)} -Argument ${psLiteral(argumentsValue)} -WorkingDirectory ${psLiteral(home)}; $user=[System.Security.Principal.WindowsIdentity]::GetCurrent().Name; $trigger=New-ScheduledTaskTrigger -AtLogOn -User $user; $principal=New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited; $settings=New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Register-ScheduledTask -TaskName ${psLiteral(WINDOWS_CODEX_TASK)} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null; Start-ScheduledTask -TaskName ${psLiteral(WINDOWS_CODEX_TASK)}`);
    const probe = context.probe ?? (async endpoint => { await withDesktopRpc(endpoint, async request => { await request("config/read", { includeLayers: false }); }, 2_000); });
    for (let attempt = 0; attempt < 8; attempt++) {
      try { await probe(config.endpoint); return config; } catch (error) {
        if (attempt === 7) throw new Error("Windows 共享后台未就绪，已保留 Codex 桌面。", { cause: error });
        await (context.wait ?? (() => new Promise(resolve => setTimeout(resolve, 500))))();
      }
    }
    throw new Error("Shared backend unavailable");
  } finally { await lock.close(); await rm(`${path}.lock`, { force: true }); }
}
