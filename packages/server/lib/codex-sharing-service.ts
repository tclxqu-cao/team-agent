import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface SharingReport {
  state: "shared" | "independent" | "failed" | "stopped" | "not-installed" | "unsupported";
  configured: boolean;
  autoStart: boolean;
  daemonReachable: boolean;
  message: string;
  backendEndpoint?: string;
  confirmationRequired?: boolean;
}
export interface SharingView extends SharingReport { runtimeMode: string | null }

export function combineSharingStatus(desktop: SharingReport, runtimeMode: string | null, runtimeEndpoint?: string | null): SharingView {
  const { backendEndpoint, ...publicDesktop } = desktop;
  const result = { ...publicDesktop, runtimeMode };
  if (["unsupported", "not-installed"].includes(desktop.state)) return result;
  if (runtimeMode === "standalone") return { ...result, state: "independent", message: "AgentRoam 正在使用独立后台。修复配置后，请在任务结束时重启 AgentRoam 和 Codex。" };
  if (runtimeMode === "desktop" && (!backendEndpoint || runtimeEndpoint !== backendEndpoint)) {
    return { ...result, state: "failed", message: "AgentRoam 当前连接的后台与默认共享后台不一致。请在任务结束后修复连接并重新打开。" };
  }
  if (!runtimeMode) return { ...result, state: "failed", message: "AgentRoam 的 Codex 后台尚未连接。请重试或修复共享连接。" };
  return result;
}

async function cliPath(): Promise<string> {
  const configured = process.env.AGENTROAM_CLI_PATH;
  const candidates = configured ? [configured] : [resolve(process.cwd(), "../cli/bin/agentroam.mjs"), resolve(process.cwd(), "packages/cli/bin/agentroam.mjs")];
  for (const path of candidates) {
    if (!isAbsolute(path)) continue;
    try { await access(path); return path; } catch { /* Next fixed location. */ }
  }
  throw new Error("未找到 AgentRoam 管理工具，请更新本机安装。");
}

let repair: Promise<SharingReport> | null = null;
let switching = false;
export async function prepareCodexSharing(): Promise<SharingReport> {
  if (!["darwin", "win32"].includes(process.platform)) return readCodexSharing();
  if (switching) throw new Error("正在切换共享后台，请稍后重试。");
  switching = true;
  try {
    const args = [await cliPath(), "codex-desktop", "--setup"];
    if (process.env.AGENTROAM_DATA_DIR) args.push("--data-dir", process.env.AGENTROAM_DATA_DIR);
    const { stdout } = await execute(process.execPath, args, { env: { ...process.env, AGENTROAM_CODEX_DESKTOP_NONINTERACTIVE: "1" }, timeout: 90_000, maxBuffer: 1024 * 1024 });
    const confirmationRequired = stdout.split("\n").some(line => {
      try { return JSON.parse(line).codexSharingAction === "confirmation-required"; } catch { return false; }
    });
    return { ...await readCodexSharing(), confirmationRequired };
  } finally { switching = false; }
}
interface SwitchContext {
  read?: typeof readCodexSharing;
  launch?: (restart: boolean) => Promise<void>;
  wait?: () => Promise<void>;
}

export async function switchCodexSharing(restartConfirmed: boolean, context: SwitchContext = {}): Promise<SharingReport> {
  if (switching) throw new Error("正在切换共享后台，请稍后刷新状态。");
  switching = true;
  try {
    const read = context.read ?? readCodexSharing;
    const before = await read();
    if (before.state === "shared") return before;
    if (["unsupported", "not-installed"].includes(before.state)) throw new Error(before.message);
    if (before.state !== "stopped" && !restartConfirmed) {
      throw new Error("需要确认退出并重启 Codex 桌面；这可能中断桌面端正在执行的任务。");
    }
    await (context.launch ?? (async restart => {
      const args = [await cliPath(), "codex-desktop", ...(restart ? ["--restart"] : [])];
      if (process.env.AGENTROAM_DATA_DIR) args.push("--data-dir", process.env.AGENTROAM_DATA_DIR);
      try {
        await execute(process.execPath, args, { env: process.env, timeout: 65_000, maxBuffer: 1024 * 1024 });
      } catch {
        throw new Error("Codex 未能完成强制重启或共享启动，请刷新状态后重试；共享后端和 AgentRoam 服务未被结束。");
      }
    }))(restartConfirmed && before.state !== "stopped");
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = await read();
      if (current.state === "shared") return current;
      if (attempt < 7) await (context.wait ?? (() => new Promise(resolve => setTimeout(resolve, 1_000))))();
    }
    throw new Error("已请求启动 Codex，但尚未验证共享连接成功。请稍后刷新；不要重复新建会话。");
  } finally { switching = false; }
}

export async function readCodexSharing(repairConfiguration = false): Promise<SharingReport> {
  if (!["darwin", "win32"].includes(process.platform)) return { state: "unsupported", configured: false, autoStart: false, daemonReachable: false, message: "当前系统暂不支持 Codex 桌面共享配置。" };
  const run = async (): Promise<SharingReport> => {
    const args = [await cliPath(), "codex-desktop", repairConfiguration ? "--repair" : "--status"];
    if (process.env.AGENTROAM_DATA_DIR) args.push("--data-dir", process.env.AGENTROAM_DATA_DIR);
    const { stdout } = await execute(process.execPath, args, { env: process.env, timeout: 45_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout) as SharingReport;
    if (!["shared", "independent", "failed", "stopped", "not-installed", "unsupported"].includes(result.state)
      || typeof result.message !== "string" || [result.configured, result.autoStart, result.daemonReachable].some(value => typeof value !== "boolean")) {
      throw new Error("共享状态响应无效，请更新管理工具。");
    }
    return result;
  };
  if (!repairConfiguration) return run();
  repair ??= run().finally(() => { repair = null; });
  return repair;
}
