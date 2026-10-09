import { openSync, closeSync } from "node:fs";
import { createInterface } from "node:readline";
import { ReadStream, WriteStream } from "node:tty";
import { fileURLToPath } from "node:url";
import type { CliOptions } from "./args.js";
import { runCodexDesktopCommand } from "./codex-desktop-command.js";
import { inspectCodexDesktop, type DesktopSnapshot } from "./codex-desktop-status.js";
import type { ServiceConfig } from "./service/service-files.js";

interface DesktopSetupContext {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  service?: ServiceConfig;
  inspect?: typeof inspectCodexDesktop;
  launch?: (options: CliOptions, environment: NodeJS.ProcessEnv) => Promise<void>;
  confirm?: (question: string) => Promise<string | null>;
  log?: (message: string) => void;
}

export async function setupCodexDesktop(options: CliOptions, context: DesktopSetupContext = {}): Promise<void> {
  if ((context.platform ?? process.platform) !== "darwin") return;
  const log = context.log ?? console.log;
  const environment = { ...(context.environment ?? process.env) };
  if (context.service?.dataDir === options.dataDir) {
    if (!environment.CODEX_HOME && context.service.codexHome) environment.CODEX_HOME = context.service.codexHome;
    if (!environment.AGENT_CODEX_BIN && context.service.codexPath) environment.AGENT_CODEX_BIN = context.service.codexPath;
  }
  const inspect = context.inspect ?? inspectCodexDesktop;
  const deferred = () => log("已保留当前 Codex 桌面端。扫码仍可连接 AgentRoam；原桌面会话暂未共享，可稍后执行 agentroam codex-desktop --setup。");
  try {
    let snapshot = await inspect(environment);
    if (snapshot.status === "not-installed") {
      log("未安装官方 Codex 桌面端，继续生成扫码连接入口。");
      return;
    }
    const original = snapshot;
    let restartConfirmed = false;
    if (snapshot.status === "running" && snapshot.activity.state === "idle") {
      // Read every loaded thread again immediately before choosing automatic restart.
      snapshot = await inspect(environment);
      if (!sameDesktop(original, snapshot)) { log("桌面进程已变化，本次保留桌面。"); deferred(); return; }
    }
    if (snapshot.status === "running" && snapshot.activity.state !== "idle") {
      const reason = snapshot.activity.state === "busy"
        ? `官方 Codex 桌面端当前有 ${snapshot.activity.activeCount} 个运行中的会话。`
        : "无法可靠确认官方 Codex 桌面端的全部任务已结束。";
      log(reason);
      const answer = await (context.confirm ?? confirmDesktopRestart)("现在重启桌面端以共享会话？重启可能中断桌面端的所有运行任务；选择保留则暂不能共享原桌面会话 [y/N]：");
      if (!answer || !/^(?:y|yes)$/i.test(answer.trim())) { deferred(); return; }
      restartConfirmed = true;
      const checked = await inspect(environment);
      if (!sameDesktop(snapshot, checked)) { log("确认后桌面进程已变化，本次保留桌面。"); deferred(); return; }
      snapshot = checked;
    }
    if (snapshot.status !== "running" && snapshot.status !== "stopped") return;
    environment.CODEX_DESKTOP_APP = snapshot.appPath;
    environment.AGENTROAM_CODEX_DESKTOP_EXPECTED_PID = snapshot.status === "running" ? String(snapshot.pid) : "0";
    if (snapshot.status === "running" && !restartConfirmed) {
      environment.AGENTROAM_CODEX_DESKTOP_IDLE_GUARD = fileURLToPath(new URL("./codex-desktop-idle-guard.js", import.meta.url));
      environment.AGENTROAM_CODEX_DESKTOP_GUARD_NODE = process.execPath;
    } else {
      delete environment.AGENTROAM_CODEX_DESKTOP_IDLE_GUARD;
      delete environment.AGENTROAM_CODEX_DESKTOP_GUARD_NODE;
    }
    const launchOptions: CliOptions = { ...options, command: "codex-desktop", desktopSetup: false,
      desktopDryRun: false, desktopRestart: snapshot.status === "running" };
    log(snapshot.status === "stopped" ? "正在启动官方 Codex 桌面端并连接共享后端…" : "正在重新连接官方 Codex 桌面端的共享后端…");
    await (context.launch ?? ((args, env) => runCodexDesktopCommand(args, { environment: env, log })))(launchOptions, environment);
    log("已尝试桌面连接，随后显示扫码入口。AgentRoam 将根据实际连接结果，依次使用桌面、shared、standalone 后端。");
  } catch (error) {
    log(`桌面共享连接未完成：${error instanceof Error ? error.message : error}`);
    log("AgentRoam 安装继续，扫码可连接；后端按桌面 → shared → standalone 回退。原桌面会话暂未确认共享，可稍后执行 agentroam codex-desktop --setup 重试。");
  }
}

function sameDesktop(previous: DesktopSnapshot, current: DesktopSnapshot): boolean {
  return previous.status === "running" && current.status === "running"
    && previous.pid === current.pid && previous.appPath === current.appPath;
}

/** curl | sh owns stdin. Only the controlling terminal can authorize restart. */
export async function confirmDesktopRestart(question: string): Promise<string | null> {
  let inputFd: number | undefined;
  let outputFd: number | undefined;
  let input: ReadStream | undefined;
  let output: WriteStream | undefined;
  let reader: ReturnType<typeof createInterface> | undefined;
  try {
    inputFd = openSync("/dev/tty", "r");
    outputFd = openSync("/dev/tty", "w");
    input = new ReadStream(inputFd);
    output = new WriteStream(outputFd);
    reader = createInterface({ input, output, terminal: true });
    const prompt = reader;
    return await new Promise<string | null>((resolve) => {
      prompt.once("close", () => resolve(null));
      prompt.once("SIGINT", () => resolve(null));
      input!.once("error", () => resolve(null));
      output!.once("error", () => resolve(null));
      prompt.question(question, resolve);
    });
  } catch {
    return null;
  } finally {
    reader?.close();
    if (input) input.destroy(); else if (inputFd !== undefined) closeSync(inputFd);
    if (output) output.destroy(); else if (outputFd !== undefined) closeSync(outputFd);
  }
}
