import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

export type HubAdapterId = "deepseek" | "chatgpt" | "gemini" | "grok" | "generic";

export interface HubSite {
  id: string;
  name: string;
  url: string;
  icon?: string;
  adapter?: HubAdapterId;
}

export interface HubConfig {
  version: 1;
  sites: HubSite[];
}

export const PRESET_SITES: HubSite[] = [
  { id: "deepseek", name: "DeepSeek", url: "https://chat.deepseek.com/", adapter: "deepseek" },
  { id: "chatgpt", name: "ChatGPT", url: "https://chatgpt.com/", adapter: "chatgpt" },
  { id: "gemini", name: "Gemini", url: "https://gemini.google.com/app", adapter: "gemini" },
  { id: "grok", name: "Grok", url: "https://grok.com/", adapter: "grok" },
];

const ADAPTER_IDS: readonly HubAdapterId[] = ["deepseek", "chatgpt", "gemini", "grok", "generic"];

export function defaultHubConfig(): HubConfig {
  return { version: 1, sites: PRESET_SITES.map((site) => ({ ...site })) };
}

export function newCustomSiteId(): string {
  return `custom-${randomUUID().slice(0, 8)}`;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isAdapterId(value: unknown): value is HubAdapterId {
  return typeof value === "string" && (ADAPTER_IDS as readonly string[]).includes(value);
}

// 容错归一化：坏条目丢弃、id 去重、字段截断，保证返回值永远可用
export function normalizeHubConfig(raw: unknown): HubConfig {
  if (!raw || typeof raw !== "object") return defaultHubConfig();
  const { sites } = raw as { sites?: unknown };
  if (!Array.isArray(sites)) return defaultHubConfig();
  const normalized: HubSite[] = [];
  const seen = new Set<string>();
  for (const item of sites) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (!isHttpUrl(entry.url)) continue;
    const url: string = entry.url;
    const name = typeof entry.name === "string" && entry.name.trim()
      ? entry.name.trim().slice(0, 40)
      : new URL(url).hostname;
    let id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim().slice(0, 64) : newCustomSiteId();
    while (seen.has(id)) id = newCustomSiteId();
    seen.add(id);
    normalized.push({
      id,
      name,
      url,
      ...(typeof entry.icon === "string" && entry.icon ? { icon: entry.icon.slice(0, 200_000) } : {}),
      ...(isAdapterId(entry.adapter) ? { adapter: entry.adapter } : {}),
    });
  }
  if (normalized.length === 0) return defaultHubConfig();
  return { version: 1, sites: normalized };
}

// 原子写 + 损坏恢复；IO 与纯函数分离以便测试（路径由调用方注入）
export class HubConfigStore {
  constructor(private readonly filePath: string) {}

  loadSync(): { config: HubConfig; resetFromCorruption: boolean } {
    if (!existsSync(this.filePath)) {
      const config = defaultHubConfig();
      this.saveSync(config);
      return { config, resetFromCorruption: false };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      // 文件存在但损坏：备份后重置默认
      try {
        renameSync(this.filePath, `${this.filePath}.bak`);
      } catch {
        // 备份失败也继续重置，不要让坏配置阻塞启动
      }
      const config = defaultHubConfig();
      this.saveSync(config);
      return { config, resetFromCorruption: true };
    }
    const config = normalizeHubConfig(raw);
    this.saveSync(config);
    return { config, resetFromCorruption: false };
  }

  saveSync(config: HubConfig): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const payload = JSON.stringify(config, null, 2);
    const tmp = `${this.filePath}.tmp`;
    try {
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, this.filePath);
    } catch {
      writeFileSync(this.filePath, payload, "utf8");
    }
  }
}
