import { execFile } from "node:child_process";
import { access, chmod, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, promisify } from "node:util";
import { resolveCodexRuntime } from "./codex-runtime-manager.js";
import { inspectCodexDesktop } from "./codex-desktop-status.js";
import { withDesktopRpc } from "./codex-desktop-probe.js";
import { detectPlatform } from "./platform.js";
import { writePrivateText } from "./service/service-files.js";

const executeFile = promisify(execFile);
export const CODEX_SHARING_LABEL = "com.agentroam.codex-desktop-shared-env";
export interface SharingContext {
  platform?: NodeJS.Platform;
  homeDir?: string;
  uid?: number;
  environment?: NodeJS.ProcessEnv;
  execute?: typeof executeFile;
  inspect?: typeof inspectCodexDesktop;
  probe?: (endpoint: string) => Promise<void>;
}
export interface CodexSharingStatus {
  state: "shared" | "independent" | "failed" | "stopped" | "not-installed" | "unsupported";
  configured: boolean;
  autoStart: boolean;
  daemonReachable: boolean;
  message: string;
  backendEndpoint?: string;
}

function locations(context: SharingContext) {
  const home = resolve(context.homeDir ?? homedir());
  const environment = context.environment ?? process.env;
  const codexHome = resolve(environment.CODEX_HOME || resolve(home, ".codex"));
  const socketPath = resolve(codexHome, "app-server-control/app-server-control.sock");
  return { home, environment, codexHome, socketPath,
    endpoint: `ws+unix://localhost${encodeURI(socketPath).replaceAll("#", "%23").replaceAll("?", "%3F").replaceAll(":", "%3A")}:/rpc`,
    root: resolve(home, ".agentroam/codex-desktop"),
    plist: resolve(home, "Library/LaunchAgents", `${CODEX_SHARING_LABEL}.plist`),
    target: `gui/${context.uid ?? process.getuid?.() ?? 0}/${CODEX_SHARING_LABEL}`,
  };
}

/** Save defaults and ensure the daemon; never quit Desktop or restart a live backend. */
export async function configureCodexSharing(options: { dataDir: string }, context: SharingContext = {}): Promise<void> {
  if ((context.platform ?? process.platform) !== "darwin") return;
  const paths = locations(context);
  const environment = { ...paths.environment };
  const executable = environment.AGENT_CODEX_BIN || (await resolveCodexRuntime({
    dataDir: options.dataDir, target: detectPlatform(), environment,
  })).executable;
  if (!executable.startsWith("/")) throw new Error("Codex 运行文件必须使用绝对路径");
  await access(executable, constants.X_OK);
  const execute = context.execute ?? executeFile;
  const script = resolve(paths.root, "watchdog.sh");
  await writePrivateText(script, await readFile(fileURLToPath(new URL("../install/codex-shared-watchdog.sh", import.meta.url)), "utf8"));
  const args = [script, executable, paths.codexHome, paths.endpoint, environment.PATH || "/usr/bin:/bin:/usr/sbin:/sbin", paths.home];
  const definition = {
    Label: CODEX_SHARING_LABEL, ProgramArguments: ["/bin/bash", ...args],
    RunAtLoad: true, StartInterval: 15, ProcessType: "Background", WorkingDirectory: paths.home,
    StandardOutPath: resolve(paths.root, "watchdog.log"), StandardErrorPath: resolve(paths.root, "watchdog-error.log"),
  };
  const json = `${paths.root}/job.json`;
  const temporary = `${paths.root}/job.plist`;
  const commandOptions = { encoding: "utf8" as const, timeout: 20_000, maxBuffer: 1024 * 1024 };
  // Identical startup calls must not unload/reload an already healthy job.
  let unchanged = false;
  try {
    const current = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", paths.plist], commandOptions);
    unchanged = isDeepStrictEqual(JSON.parse(String(current.stdout)), definition);
  } catch { /* First install or older definition. */ }
  if (!unchanged) {
    await writePrivateText(json, JSON.stringify(definition));
    try {
      await execute("/usr/bin/plutil", ["-convert", "xml1", "-o", temporary, json], commandOptions);
      await chmod(temporary, 0o600);
      await mkdir(dirname(paths.plist), { recursive: true });
      let loaded = false;
      try { await execute("/bin/launchctl", ["print", paths.target], commandOptions); loaded = true; } catch { /* Absent job. */ }
      if (loaded) await execute("/bin/launchctl", ["bootout", paths.target], commandOptions);
      await rename(temporary, paths.plist);
    } finally { await Promise.all([rm(json, { force: true }), rm(temporary, { force: true })]); }
  }
  await execute("/bin/launchctl", ["enable", paths.target], commandOptions);
  let loaded = false;
  try { await execute("/bin/launchctl", ["print", paths.target], commandOptions); loaded = true; } catch { /* bootstrap below */ }
  if (!loaded) await execute("/bin/launchctl", ["bootstrap", paths.target.slice(0, paths.target.lastIndexOf("/")), paths.plist], commandOptions);
  // Make defaults effective now as well as on the next GUI login.
  await execute("/bin/bash", args, { ...commandOptions, env: environment, cwd: paths.home });
}

/** Read process/socket evidence; configuration by itself never proves sharing. */
export async function inspectCodexSharing(context: SharingContext = {}): Promise<CodexSharingStatus> {
  const result: CodexSharingStatus = { state: "failed", configured: false, autoStart: false, daemonReachable: false, message: "共享连接检查失败，请修复后重试。" };
  if ((context.platform ?? process.platform) !== "darwin") return { ...result, state: "unsupported", message: "当前系统暂不支持 Codex 桌面共享配置。" };
  const paths = locations(context);
  result.backendEndpoint = paths.endpoint;
  const execute = context.execute ?? executeFile;
  const commandOptions = { encoding: "utf8" as const, timeout: 4_000, maxBuffer: 4 * 1024 * 1024 };
  try {
    const current = await execute("/bin/launchctl", ["getenv", "CODEX_APP_SERVER_WS_URL"], commandOptions).catch(() => ({ stdout: "" }));
    const [force, home] = await Promise.all([
      execute("/bin/launchctl", ["getenv", "CODEX_APP_SERVER_FORCE_CLI"], commandOptions).catch(() => ({ stdout: "" })),
      execute("/bin/launchctl", ["getenv", "CODEX_HOME"], commandOptions).catch(() => ({ stdout: "" })),
    ]);
    result.configured = String(current.stdout).trim() === paths.endpoint && String(force.stdout).trim() !== "1"
      && (String(home.stdout).trim() || resolve(paths.home, ".codex")) === paths.codexHome;
    try {
      const job = await execute("/bin/launchctl", ["print", paths.target], commandOptions);
      const plist = await execute("/usr/bin/plutil", ["-convert", "json", "-o", "-", paths.plist], commandOptions);
      const definition = JSON.parse(String(plist.stdout));
      await access(resolve(paths.root, "watchdog.sh"), constants.R_OK);
      await access(definition.ProgramArguments?.[2] ?? "", constants.X_OK);
      result.autoStart = Boolean(job.stdout) && definition.RunAtLoad === true && definition.StartInterval === 15
        && definition.ProgramArguments?.[0] === "/bin/bash" && definition.ProgramArguments?.[1] === resolve(paths.root, "watchdog.sh")
        && definition.ProgramArguments?.[3] === paths.codexHome && definition.ProgramArguments?.[4] === paths.endpoint;
    } catch { /* Missing or outdated watchdog. */ }
    try {
      await (context.probe ?? (async endpoint => { await withDesktopRpc(endpoint, async request => { await request("config/read", { includeLayers: false }); }, 4_000); }))(paths.endpoint);
      result.daemonReachable = true;
    } catch { /* Keep checking private Desktop evidence. */ }
    const desktop = await (context.inspect ?? inspectCodexDesktop)(paths.environment);
    if (desktop.status !== "running") return { ...result, state: desktop.status, message: desktop.status === "stopped"
      ? result.configured && result.autoStart && result.daemonReachable ? "Codex 尚未启动；下次打开时使用共享后台。" : "Codex 尚未启动；请先修复共享配置。" : "尚未安装官方 Codex 桌面端。" };
    const { stdout } = await execute("/bin/ps", ["-axo", "pid=,ppid=,args="], commandOptions);
    const processes = String(stdout).split("\n").flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
      return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]! }] : [];
    });
    if (processes.some(p => p.parent === desktop.pid && /\bapp-server\b/.test(p.command) && !/\b(?:proxy|daemon)\b/.test(p.command))) {
      return { ...result, state: "independent", message: "Codex 正在使用独立后台。修复后，请在任务结束时退出并重新打开 Codex。" };
    }
    if (!result.daemonReachable) return result;
    const socket = await realpath(paths.socketPath);
    const pids = [desktop.pid, ...processes.filter(p => /\bapp-server\b/.test(p.command) && /\bcodex\b/.test(p.command)).map(p => p.pid)];
    const sockets = await execute("/usr/sbin/lsof", ["-nP", "-a", "-p", [...new Set(pids)].join(","), "-U"], commandOptions);
    const rows = String(sockets.stdout).split("\n").flatMap(line => {
      const match = /^\S+\s+(\d+)\s+\S+\s+\S+\s+unix\s+(0x[\da-f]+)\s+\S+\s+(.*)$/i.exec(line);
      return match ? [{ pid: Number(match[1]), device: match[2], name: match[3]!.trim() }] : [];
    });
    const devices = new Set(rows.filter(row => row.pid !== desktop.pid && row.name === socket).map(row => row.device));
    if (rows.some(row => row.pid === desktop.pid && row.name.startsWith("->") && devices.has(row.name.slice(2)))) {
      return { ...result, state: "shared", message: "Codex 已连接共享后台。" };
    }
    return { ...result, message: "共享后台可用，但尚未确认 Codex 连接。请修复后，在任务结束时重新打开 Codex。" };
  } catch { return result; }
}
