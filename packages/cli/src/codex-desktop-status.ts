import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { probeDesktopActivity, type DesktopActivity } from "./codex-desktop-probe.js";

const execFileAsync = promisify(execFile);
export type DesktopSnapshot =
  | { status: "not-installed" }
  | { status: "stopped"; appPath: string }
  | { status: "running"; appPath: string; pid: number; activity: DesktopActivity };

interface InspectionContext {
  execute?: typeof execFileAsync;
  executableExists?: (path: string) => Promise<boolean>;
  probe?: typeof probeDesktopActivity;
}

export async function inspectCodexDesktop(environment: NodeJS.ProcessEnv, context: InspectionContext = {}): Promise<DesktopSnapshot> {
  const executableExists = context.executableExists ?? (async (path: string) => {
    try { await access(path, constants.X_OK); return true; } catch { return false; }
  });
  let appPath = environment.CODEX_DESKTOP_APP;
  if (!appPath) appPath = await executableExists("/Applications/ChatGPT.app") ? "/Applications/ChatGPT.app" : "/Applications/Codex.app";
  const binary = join(appPath, "Contents/MacOS", basename(appPath, ".app"));
  if (!await executableExists(binary)) return { status: "not-installed" };
  const execute = context.execute ?? execFileAsync;
  const commandOptions = { encoding: "utf8" as const, timeout: 1_500, maxBuffer: 2 * 1024 * 1024 };
  const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,args="], commandOptions);
  const processes = String(stdout).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3]! }] : [];
  });
  const desktops = processes.filter(({ command }) => command === binary || command.startsWith(`${binary} `));
  if (!desktops.length) return { status: "stopped", appPath };
  const pid = desktops[0]!.pid;
  const unknown = (reason: string): DesktopSnapshot => ({ status: "running", appPath, pid, activity: { state: "unknown", reason } });
  if (desktops.length !== 1) return unknown("检测到多个官方桌面进程，无法完整确认任务状态");
  const servers = processes.filter((process) => process.parentPid === pid && /^(?:.*\/)?codex\s.*\bapp-server(?:\s|$)/.test(process.command));
  if (servers.length !== 1) return unknown("桌面端未提供可完整查询的独立后端");
  const server = servers[0]!;
  const listenUrl = /(?:^|\s)--listen(?:=|\s+)(unix:\/\/.*?|ws:\/\/\S+)(?=\s+-|$)/.exec(server.command)?.[1];
  if (!listenUrl || /\bapp-server\s+(?:proxy|daemon)\b/.test(server.command)) {
    return unknown("桌面端使用私有后端，无法可靠判断全部会话是否空闲");
  }
  let endpoint: string | null = null;
  try {
    if (listenUrl.startsWith("ws://")) {
      const address = new URL(listenUrl);
      if (["0.0.0.0", "[::]"].includes(address.hostname)) address.hostname = "localhost";
      if (!["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) || address.port === "0") throw new Error("not local");
      const result = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(server.pid), "-iTCP", "-sTCP:LISTEN", "-Ftn"], commandOptions);
      const port = address.port || "80";
      if (String(result.stdout).split("\n").some((line) => /^n(?:127\.0\.0\.1|localhost|\[::1\]|\*|0\.0\.0\.0|\[::\]):(\d+)$/.exec(line)?.[1] === port)) endpoint = address.href;
    } else {
      const result = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", String(server.pid), "-U", "-Ftn"], commandOptions);
      const requested = listenUrl.slice("unix://".length);
      const paths: string[] = [];
      let unix = false;
      for (const line of String(result.stdout).split("\n")) {
        if (line.startsWith("t")) unix = line === "tunix";
        if (!unix || !line.startsWith("n/")) continue;
        const path = line.slice(1).split(" type=")[0]!;
        if (path.includes(" -> ") || path.includes(":")) continue;
        if (!requested || path === requested) paths.push(path);
      }
      if (paths.length === 1) endpoint = `ws+unix://localhost${encodeURI(paths[0]!)}:/rpc`;
    }
    if (!endpoint) return unknown("未找到归属桌面端的可连接监听地址");
    return { status: "running", appPath, pid, activity: await (context.probe ?? probeDesktopActivity)(endpoint) };
  } catch {
    return unknown("无法完整查询桌面端的实时任务状态");
  }
}
