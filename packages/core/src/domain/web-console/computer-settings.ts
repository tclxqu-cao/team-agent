export const COMPUTER_TOOLS = ["refresh", "dashboard", "collaboration", "remote", "theme", "files", "ai-hub", "flow", "install"] as const;
export type ComputerToolId = typeof COMPUTER_TOOLS[number];
export const DEFAULT_COMPUTER_TOOLS: readonly ComputerToolId[] = ["refresh", "remote", "theme", "files"];

export interface SavedComputerPage {
  id: string;
  name: string;
  url: string;
  openMode: "current" | "new-tab";
}

export interface ComputerSettings {
  userId: string;
  revision: number;
  visibleTools: ComputerToolId[];
  /** NULL means legacy browser pages have not been imported yet; [] means initialized and empty. */
  savedPages: SavedComputerPage[] | null;
  updatedAt: string;
}

export function defaultComputerSettings(userId: string): ComputerSettings {
  return { userId, revision: 0, visibleTools: [...DEFAULT_COMPUTER_TOOLS], savedPages: null, updatedAt: "" };
}

export function validateComputerTools(value: unknown): ComputerToolId[] {
  if (!Array.isArray(value) || value.length > COMPUTER_TOOLS.length || value.some(id => !COMPUTER_TOOLS.includes(id))) {
    throw new Error("顶部工具包含未知选项。");
  }
  if (new Set(value).size !== value.length) throw new Error("顶部工具不能重复。");
  return COMPUTER_TOOLS.filter(id => value.includes(id));
}

export function validateSavedComputerPages(value: unknown): SavedComputerPage[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error("每台电脑最多可添加 20 个页面。");
  const ids = new Set<string>();
  return value.map(entry => {
    if (!entry || typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(entry.id) || ids.has(entry.id)) {
      throw new Error("页面标识无效或重复。");
    }
    if (typeof entry.name !== "string" || !entry.name.trim() || entry.name.trim().length > 60) throw new Error("页面名称需为 1–60 个字符。");
    if (!["current", "new-tab"].includes(entry.openMode)) throw new Error("页面打开方式无效。");
    if (typeof entry.url !== "string" || entry.url.length > 8192) throw new Error("请填写有效的 http(s) 页面地址。");
    let url: URL;
    try { url = new URL(entry.url.trim()); } catch { throw new Error("请填写有效的 http(s) 页面地址。"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("请填写无账号密码的 http(s) 页面地址。");
    ids.add(entry.id);
    return { id: entry.id, name: entry.name.trim(), url: url.href, openMode: entry.openMode };
  });
}
