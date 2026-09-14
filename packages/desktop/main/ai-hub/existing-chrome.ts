import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
/** LaunchServices reuses the ordinary Chrome instance/profile. Never add debugging or profile flags. */
export async function openExistingChrome(url: string, run = execFileAsync): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error("无效的浏览器地址");
  if (process.platform !== "darwin") throw new Error("此连接入口目前支持 macOS Google Chrome");
  await run("/usr/bin/open", ["-a", "Google Chrome", parsed.href]);
}

/** Fixed internal page, separate from the HTTPS-only site navigation entry. */
export async function openChromeExtensions(run = execFileAsync): Promise<void> {
  if (process.platform !== "darwin") throw new Error("此连接入口目前支持 macOS Google Chrome");
  await run("/usr/bin/open", ["-a", "Google Chrome", "chrome://extensions/"]);
}
