import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { DesktopProbeRpcError, readDesktopActivity, withDesktopRpc } from "./codex-desktop-probe.js";

const execFileAsync = promisify(execFile);
interface PreflightContext { restart?: () => Promise<void>; log?: (message: string) => void }

async function inspectBackend(endpoint: string): Promise<boolean> {
  return withDesktopRpc(endpoint, async (request, becameActive) => {
    try {
      await request("config/read", {});
      try { await request("account/gatewayOAuth/read", {}); }
      catch (error) {
        // Older servers may not have the Desktop gateway RPC.
        if (!(error instanceof DesktopProbeRpcError && error.code === -32601)) throw error;
      }
      return true;
    } catch (error) {
      if (!(error instanceof DesktopProbeRpcError) || !/No such file or directory|os error 2/.test(error.message)) throw error;
      const activity = await readDesktopActivity(request);
      if (activity.state !== "idle" || becameActive()) throw new Error("共享后端配置失效，但任务忙碌或状态无法确认；已保留桌面和共享后端");
      return false;
    }
  });
}

/** Repair only a missing-directory backend after two complete idle snapshots. */
export async function preflightCodexDesktop(endpoint: string, executable: string, context: PreflightContext = {}): Promise<void> {
  if (await inspectBackend(endpoint)) return;
  if (await inspectBackend(endpoint)) return;
  (context.log ?? console.log)("共享后端的工作目录已失效，已确认全部任务空闲，正在从稳定目录重建…");
  await (context.restart ?? (async () => {
    await execFileAsync(executable, ["app-server", "daemon", "restart"], {
      cwd: homedir(), env: process.env, timeout: 15_000, maxBuffer: 1024 * 1024,
    });
  }))();
  if (!await inspectBackend(endpoint)) throw new Error("共享后端重建后仍无法读取配置；已保留桌面");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [endpoint, executable] = process.argv.slice(2);
  if (!endpoint || !executable) { console.error("Missing shared backend endpoint or Codex executable"); process.exitCode = 1; }
  else preflightCodexDesktop(endpoint, executable).catch(error => {
    console.error(`共享后端检查失败：${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
