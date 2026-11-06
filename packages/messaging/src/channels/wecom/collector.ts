import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ChannelMessage } from "../../domain/types";
import type { MessageSource, MessagingSourceStore } from "../../application/ports.js";
import { resolveWecomAsset } from "./assets.js";

function python<T>(args: string[], input?: unknown, assetDir?: string): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(process.env.AGENT_WECOM_PYTHON || "/usr/bin/python3", [resolveWecomAsset("reader.py", assetDir), ...args],
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
export async function discoverWecom(assetDir?: string): Promise<WecomDiscovery> {
  if (process.platform !== "darwin") return { sources: [], error: "本地企微监听目前支持 macOS，请在已登录企微的 Mac 上运行接入服务" };
  try { return await python<WecomDiscovery>(["--discover"], undefined, assetDir); }
  catch (error) { return { sources: [], error: error instanceof Error ? error.message : "无法发现企微账号" }; }
}
export async function collectWecom(repository: MessagingSourceStore, options: { baseDir: string; assetDir?: string }): Promise<void> {
  if (process.platform !== "darwin") throw new Error("本地企微监听目前支持 macOS，请在已登录企微的 Mac 上运行接入服务");
  let settings = repository.settings();
  if (!settings.source.database || !settings.source.accountId) {
    const discovery = await discoverWecom(options.assetDir);
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
    ...settings.source, cursor, cacheDir: join(options.baseDir, ".agent-data", "messaging-wecom", identity),
  }, options.assetDir);
  repository.ingestBatch(result.messages, cursorKey, result.cursor);
  repository.status({ state: "listening", updatedAt: new Date().toISOString(), lastCollectedAt: new Date().toISOString() });
}

export class WecomSource implements MessageSource {
  constructor(private readonly repository: MessagingSourceStore, private readonly options: { baseDir: string; assetDir?: string }) {}
  collect(): Promise<void> { return collectWecom(this.repository, this.options); }
  discover(): Promise<WecomDiscovery> { return discoverWecom(this.options.assetDir); }
}
