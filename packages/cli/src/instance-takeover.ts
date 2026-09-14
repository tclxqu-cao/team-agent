import { readdir, readFile, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runCommand } from "./service/service-controller.js";
import { MacLaunchAgent } from "./service/macos-launch-agent.js";
import { WindowsTaskService } from "./service/windows-task-service.js";

type ProcessInfo = { pid: number; ppid: number; command: string };
type Descriptor = { protocol: number; instanceId: string; pid: number; url: string; dataDir: string; token: string };
interface Dependencies {
  registry?: string;
  request?: typeof fetch;
  processes?: () => Promise<ProcessInfo[]>;
  stop?: (pid: number) => Promise<void>;
  alive?: (pid: number) => boolean;
  timeoutMs?: number;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function processList(): Promise<ProcessInfo[]> {
  if (process.platform === "win32") {
    const result = await runCommand("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"]);
    if (result.code !== 0) throw new Error("无法核验旧 CLI 进程");
    return JSON.parse(result.stdout).map((p: any) => ({ pid: p.ProcessId, ppid: p.ParentProcessId, command: p.CommandLine ?? "" }));
  }
  const result = await runCommand("ps", ["-axo", "pid=,ppid=,command="]);
  if (result.code !== 0) throw new Error("无法核验旧 CLI 进程");
  return result.stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : [];
  });
}
async function stopCli(pid: number): Promise<void> {
  const service = process.platform === "win32" ? new WindowsTaskService() : new MacLaunchAgent();
  const status = await service.status();
  if (status.running && status.state?.pid === pid) { await service.stop(); return; }
  if (process.platform === "win32") {
    const result = await runCommand("taskkill", ["/PID", String(pid), "/T", "/F"]);
    if (result.code !== 0) throw new Error("旧 CLI 进程树停止失败");
  } else process.kill(pid, "SIGTERM");
}

async function isPackagedRuntime(command: string): Promise<boolean> {
  const match = /(?:^|\s)(?:"([^"]+[\\/]ws-server\.mjs)"|(\S+[\\/]ws-server\.mjs))(?=\s|$)/.exec(command);
  const gateway = match?.[1] ?? match?.[2];
  if (!gateway) return false;
  try {
    const path = await realpath(gateway);
    if (!/[\\/]node_modules[\\/]agentroam-runtime-(?:darwin-arm64|win32-x64)[\\/]runtime[\\/]ws-server\.mjs$/.test(path)) return false;
    const manifest = JSON.parse(await readFile(join(dirname(dirname(path)), "package.json"), "utf8"));
    return ["agentroam-runtime-darwin-arm64", "agentroam-runtime-win32-x64"].includes(manifest.name);
  } catch { return false; }
}

/** Authenticate the local server, then verify its CLI parent before sending any signal. */
export async function stopPreviousInstances(dataDir: string, log: (line: string) => void, dependencies: Dependencies = {}): Promise<void> {
  const canonical = await realpath(dataDir);
  const registry = dependencies.registry ?? process.env.AGENTROAM_DISCOVERY_DIR ?? join(homedir(), ".agentroam/services");
  const names = await readdir(registry).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  for (const name of names.filter(name => name.endsWith(".json"))) {
    let d: Descriptor;
    try {
      d = JSON.parse(await readFile(join(registry, name), "utf8"));
      if (d.protocol !== 1 || !Number.isSafeInteger(d.pid) || d.pid <= 1 || typeof d.instanceId !== "string" || !/^[a-f0-9]{64}$/.test(d.token)) continue;
      const actual = await realpath(d.dataDir);
      if (actual !== canonical && actual !== join(canonical, "data")) continue;
      const url = new URL(d.url);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== "/" || url.username || url.password || url.search || url.hash) continue;
    } catch { continue; }
    let identity: Partial<Descriptor>;
    try {
      const response = await (dependencies.request ?? fetch)(new URL("/api/desktop/identity", d.url), { headers: { "x-agentroam-desktop-token": d.token }, redirect: "error", signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error("实例认证失败");
      identity = await response.json() as Partial<Descriptor>;
    } catch {
      if ((dependencies.alive ?? alive)(d.pid)) throw new Error("同一数据目录的旧实例无法核验，请先停止旧实例再重试");
      continue;
    }
    if (identity.protocol !== 1 || identity.instanceId !== d.instanceId || identity.dataDir !== d.dataDir) throw new Error("旧实例身份不匹配，已取消启动");
    const processes = await (dependencies.processes ?? processList)();
    const server = processes.find(p => p.pid === d.pid);
    const parent = processes.find(p => p.pid === server?.ppid);
    const orphan = server && (server.ppid === 1 || !parent) && await isPackagedRuntime(server.command);
    if (!server || server.pid === process.pid || (!orphan && (!parent || parent.pid === process.pid || !/[\\/]ws-server\.mjs(?:["\s]|$)/.test(server.command) || !/[\\/]agentroam[\\/]bin[\\/]agentroam\.mjs(?:["\s]|$)/.test(parent.command)))) {
      throw new Error("同一数据目录已有服务，但无法确认它是可接管的 CLI 实例，请先停止该服务");
    }
    // Re-read the process relationship immediately before stopping, to reject stale PID records.
    const current = await (dependencies.processes ?? processList)();
    if (!current.some(p => p.pid === server.pid && p.ppid === server.ppid && p.command === server.command) || (!orphan && !current.some(p => p.pid === parent!.pid && p.command === parent!.command))) throw new Error("旧实例身份已变化，请重试");
    const targetPid = orphan ? server.pid : parent!.pid;
    log(orphan ? "检测到旧 CLI 遗留的服务进程，正在停止…" : "检测到同一数据目录的旧 CLI，正在停止…");
    await (dependencies.stop ?? stopCli)(targetPid);
    const deadline = Date.now() + (dependencies.timeoutMs ?? 15_000);
    while ((dependencies.alive ?? alive)(targetPid) || (dependencies.alive ?? alive)(server.pid)) {
      if (Date.now() >= deadline) throw new Error("旧 CLI 尚未退出，已取消新实例启动，请稍后重试");
      await delay(100);
    }
    log("✓ 旧 CLI 已停止，继续启动新实例");
  }
}

/** Serialize startup within a data directory; never remove a live owner's lock. */
export async function lockInstanceStartup(dataDir: string): Promise<() => Promise<void>> {
  await mkdir(dataDir, { recursive: true });
  const path = resolve(await realpath(dataDir), ".cli-start.lock");
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error("此数据目录已有 CLI 正在启动；请等它完成后重试。若上次异常退出，请确认无启动进程后移除 .cli-start.lock。");
  }
  try { await writeFile(join(path, "pid"), String(process.pid), { mode: 0o600 }); }
  catch (error) { await rm(path, { recursive: true, force: true }); throw error; }
  let released = false;
  return async () => { if (!released) { released = true; await rm(path, { recursive: true, force: true }); } };
}
