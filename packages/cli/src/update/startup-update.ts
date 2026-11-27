import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { styleText } from "node:util";
import { resolveUpdateCandidate, type StartUpdateOptions } from "./update-command.js";
import { acquireUpdateLock, sanitizeUpdateError, updatePaths } from "./update-state.js";
import { cliLauncherPath, installCliLauncher } from "./update-install.js";

const SKIP_STARTUP_UPDATE = "AGENTROAM_SKIP_STARTUP_UPDATE";

export async function updateBeforeStartup(
  options: Pick<StartUpdateOptions, "cliPath" | "currentVersion" | "target"> & { roots: string[] },
  argv: string[],
): Promise<"launched" | "current" | "unmanaged"> {
  if (process.env[SKIP_STARTUP_UPDATE] === "1") return "current";
  const dataDir = resolve(dirname(options.cliPath), "../../../../..");
  if (options.cliPath !== cliLauncherPath(dataDir, options.currentVersion)) return "unmanaged";

  try {
    console.error("正在检查 AgentRoam CLI 更新…");
    const release = await resolveUpdateCandidate({ ...options, requestedVersion: null });
    if (!release) {
      console.error(`AgentRoam CLI ${options.currentVersion} 已是最新版本`);
      return "current";
    }
    const unlock = await acquireUpdateLock(updatePaths(dataDir).lockFile);
    let entry: string;
    try {
      console.error(`${styleText("yellow", "发现新版本，正在更新 AgentRoam CLI", { stream: process.stderr })} ${options.currentVersion} → ${release.targetVersion}…`);
      entry = await installCliLauncher({ ...release, dataDir, roots: options.roots });
    } finally {
      await unlock();
    }
    console.error(`AgentRoam CLI ${release.targetVersion} 已安装，正在启动…`);
    await launchUpdatedCli(entry, argv);
    return "launched";
  } catch (error) {
    console.error(`AgentRoam CLI 自动更新未完成，继续启动当前版本。${sanitizeUpdateError(error)}`);
    return "current";
  }
}

async function launchUpdatedCli(entry: string, argv: string[]): Promise<void> {
  const environment = { ...process.env, [SKIP_STARTUP_UPDATE]: "1" };
  if (process.platform === "darwin" && process.execve) {
    return process.execve(process.execPath, [process.execPath, entry, ...argv], environment);
  }
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], {
      stdio: "inherit",
      env: environment,
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    };
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    child.once("error", error => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
      done();
    });
  });
}
