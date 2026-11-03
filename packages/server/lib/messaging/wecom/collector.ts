import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ChannelMessage } from "../../../../core/src/domain/messaging/types";
import type { SQLiteMessagingRepository } from "@agent/core";
import { getServerBaseDir } from "../../server-data-dir";

function script(): string {
  const candidates = [
    join(dirname(resolve(process.argv[1] || ".")), "lib/messaging/wecom/reader.py"),
    resolve("lib/messaging/wecom/reader.py"),
    resolve("packages/server/lib/messaging/wecom/reader.py"),
  ];
  const path = candidates.find(existsSync);
  if (!path) throw new Error("企微采集组件缺失，请重新构建运行包");
  return path;
}
function python<T>(args: string[], input?: unknown): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.env.AGENT_WECOM_PYTHON || "/usr/bin/python3", [script(), ...args],
      { timeout: 90_000, maxBuffer: 32_000_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } }, (error, stdout) => {
        try {
          const result = JSON.parse(stdout);
          if (result.error) reject(new Error(String(result.error)));
          else if (error) reject(new Error("企微采集进程异常退出"));
          else resolvePromise(result);
        } catch { reject(new Error(error?.message || "企微采集返回格式无效")); }
      });
    child.stdin?.end(input ? JSON.stringify(input) : undefined);
  });
}
export interface WecomDiscovery { sources: Array<{ database: string; accountId: string }>; error?: string }
export async function discoverWecom(): Promise<WecomDiscovery> {
  if (process.platform !== "darwin") return { sources: [], error: "本地企微监听目前支持 macOS，请在已登录企微的 Mac 上运行接入服务" };
  try { return await python<WecomDiscovery>(["--discover"]); }
  catch (error) { return { sources: [], error: error instanceof Error ? error.message : "无法发现企微账号" }; }
}
export async function collectWecom(repository: SQLiteMessagingRepository): Promise<void> {
  if (process.platform !== "darwin") throw new Error("本地企微监听目前支持 macOS，请在已登录企微的 Mac 上运行接入服务");
  let settings = repository.settings();
  if (!settings.source.database || !settings.source.accountId) {
    const discovery = await discoverWecom();
    if (discovery.sources.length !== 1) throw new Error(discovery.error || "发现多个企微账号，请在消息接入设置中选择一个");
    settings = { ...settings, source: discovery.sources[0] };
    repository.saveSettings(settings);
  }
  const identity = createHash("sha256").update(JSON.stringify(settings.source)).digest("hex").slice(0, 24);
  const cursorKey = "cursor:" + identity;
  const cursor = repository.state(cursorKey, { since: Math.floor(Date.now() / 1000), lid: "0" });
  // Save the activation baseline before the potentially long initial snapshot.
  repository.setState(cursorKey, cursor);
  const result = await python<{ messages: ChannelMessage[]; cursor: unknown }>([], {
    ...settings.source, cursor, cacheDir: join(getServerBaseDir(), ".agent-data", "messaging-wecom", identity),
  });
  repository.ingestBatch(result.messages, cursorKey, result.cursor);
  repository.status({ state: "listening", updatedAt: new Date().toISOString(), lastCollectedAt: new Date().toISOString() });
}
