import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { CliOptions } from "./args.js";
import { resolveApprovalInput, terminalText } from "./device-pairing.js";
import { localServiceRequest } from "./local-service-request.js";
import { withCliProgress, withoutCliProgress } from "../bin/cli-progress.mjs";

const runFile = promisify(execFile);
const endpoint = "/api/remote-authorization";
export interface DesktopAuthorizationStatus {
  local: boolean;
  platform: NodeJS.Platform;
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  screen: boolean;
  accessibility: boolean;
  online: boolean;
  error: string | null;
}
type Permission = "screen" | "accessibility";
interface AuthorizationBody {
  action: "request-permission" | "enable" | "disable" | "recheck";
  permission?: Permission;
}
export interface DesktopAuthorizationContext {
  platform?: NodeJS.Platform;
  isTTY?: boolean;
  log?: (message: string) => void;
  confirm?: () => Promise<boolean>;
  request?: (dataDir: string, body?: AuthorizationBody) => Promise<DesktopAuthorizationStatus>;
  wait?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
}

async function requestAuthorization(dataDir: string, body?: AuthorizationBody): Promise<DesktopAuthorizationStatus> {
  const status = await localServiceRequest<DesktopAuthorizationStatus>(dataDir, endpoint, {
    method: body ? "POST" : "GET", body, timeoutMs: body?.action === "request-permission" ? 135_000 : 30_000,
  });
  if (status.local !== true || typeof status.supported !== "boolean" || typeof status.installed !== "boolean"
    || typeof status.enabled !== "boolean" || typeof status.screen !== "boolean" || typeof status.accessibility !== "boolean"
    || typeof status.online !== "boolean" || typeof status.platform !== "string"
    || (status.error !== null && typeof status.error !== "string")) {
    throw new Error("本机远程授权状态无效，请升级 CLI 后重试");
  }
  return status;
}

/** A native macOS dialog; no browser, shell interpolation, or piped stdin. */
export async function confirmDesktopAuthorization(platform: NodeJS.Platform): Promise<boolean> {
  if (platform === "darwin") {
    const script = 'display dialog "是否启用 AgentRoam 远程桌面？\n接下来将请求屏幕录制和辅助功能权限。授权后，已配对的设备可以查看和控制这台电脑。" with title "AgentRoam 远程桌面授权" buttons {"稍后", "开始授权"} default button "开始授权" cancel button "稍后" giving up after 120';
    try {
      const { stdout } = await runFile("/usr/bin/osascript", ["-e", script], { timeout: 125_000, maxBuffer: 4096 });
      return stdout.includes("button returned:开始授权") && !stdout.includes("gave up:true");
    } catch { return false; }
  }
  const input = resolveApprovalInput({ interactive: true });
  if (!input) return false;
  const reader = createInterface({ input, output: process.stdout });
  try {
    const answer = await withoutCliProgress(() => reader.question("启用远程桌面，允许已配对设备查看和控制这台电脑？[y/N]："));
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    reader.close();
    if (input !== process.stdin && input instanceof Readable) input.destroy();
  }
}

function recoveryHint(log: (line: string) => void): void {
  log("稍后重新授权：agentroam desktop authorize；也可在本机浏览器的“远程授权”面板中操作。");
}

function complete(status: DesktopAuthorizationStatus): boolean {
  return status.enabled && status.screen && status.accessibility && !status.error;
}

/** Request permissions without enabling sharing, then verify before activation. */
export async function authorizeRemoteDesktop(dataDir: string, context: DesktopAuthorizationContext = {}): Promise<boolean> {
  const log = context.log ?? console.log;
  if (!(context.isTTY ?? process.stdout.isTTY === true)) {
    log("未检测到交互终端，已跳过远程桌面授权。");
    recoveryHint(log);
    return false;
  }
  const request = context.request ?? requestAuthorization;
  let status = await withCliProgress("正在检查本机远程桌面权限", () => request(dataDir));
  if (!status.supported) throw new Error("远程桌面支持 macOS 14 及以上的 Apple Silicon 电脑和 Windows 10/11 x64");
  if (!status.installed) throw new Error("当前 CLI 未包含远程授权组件，请升级 CLI");
  if (status.enabled) {
    status = await request(dataDir, { action: "recheck" });
    if (complete(status)) { log("✓ 远程桌面已授权并开启共享。"); return true; }
  }
  const platform = context.platform ?? process.platform;
  const confirm = context.confirm ?? (() => confirmDesktopAuthorization(platform));
  const confirmed = await (platform === "darwin"
    ? withCliProgress("正在等待本机授权弹窗确认", confirm)
    : withoutCliProgress(confirm));
  if (!confirmed) {
    log("已跳过远程桌面授权。");
    recoveryHint(log);
    return false;
  }
  status = await request(dataDir, { action: "recheck" });
  const wait = context.wait ?? delay;
  if (platform === "darwin") {
    for (const permission of ["screen", "accessibility"] as const) {
      if (status[permission]) continue;
      const name = permission === "screen" ? "屏幕录制" : "辅助功能";
      log(`正在请求${name}权限，请在系统设置中允许 AgentRoam Remote Desktop…`);
      status = await withCliProgress(`正在等待${name}权限，请在系统弹窗或设置中允许`, async () => {
        let current = await request(dataDir, { action: "request-permission", permission });
        for (let attempt = 0; !current[permission] && attempt < (context.pollAttempts ?? 60); attempt++) {
          await wait(2000);
          current = await request(dataDir, { action: "recheck" });
        }
        return current;
      });
      if (!status[permission]) {
        log(`${name}权限尚未授予，本次未开启共享。`);
        recoveryHint(log);
        return false;
      }
    }
  }
  if (!status.screen || !status.accessibility) {
    log("远程桌面尚不可用，请确认系统权限及当前桌面状态，本次未开启共享。");
    recoveryHint(log);
    return false;
  }
  status = await withCliProgress("正在开启并检查远程桌面共享", () => request(dataDir, { action: "enable" }));
  if (!complete(status)) throw new Error(status.error ? terminalText(status.error) : "远程桌面共享未就绪，请重新检查系统权限");
  log("✓ 远程桌面授权完成，已开启共享。手机首次连接仍需设备配对。");
  return true;
}

export async function runDesktopCommand(options: CliOptions, context: DesktopAuthorizationContext = {}): Promise<void> {
  const log = context.log ?? console.log;
  const request = context.request ?? requestAuthorization;
  if (options.desktopAction === "authorize") {
    try {
      if (!await authorizeRemoteDesktop(options.dataDir, context)) process.exitCode = 1;
    } catch (error) {
      recoveryHint(log);
      throw error;
    }
    return;
  }
  let status = await request(options.dataDir);
  if (options.desktopAction === "disable") {
    status = await request(options.dataDir, { action: "disable" });
    if (status.enabled) throw new Error("远程桌面共享尚未关闭，请重试");
    log("✓ 已关闭远程桌面共享，系统权限保留。重新开启：agentroam desktop authorize");
    return;
  }
  if (status.supported && status.installed) status = await request(options.dataDir, { action: "recheck" });
  log(`远程桌面：${status.supported ? "支持" : "不支持"}；共享：${status.enabled ? "已开启" : "未开启"}；屏幕录制：${status.screen ? "已授权" : "未授权或桌面不可用"}；辅助功能：${status.accessibility ? "已授权" : "未授权"}`);
  if (status.error) log(`状态提示：${terminalText(status.error)}`);
  recoveryHint(log);
}
