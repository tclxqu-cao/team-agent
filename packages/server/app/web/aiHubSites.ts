// AI Hub 站点目录（web 控制台侧）。
// 浏览器无法跨域注入，发送采用"新标签直达 + 剪贴板接力"：
// 支持 ?q= 的站点直接带上问题（打开即自动发送），其余站点打开首页、问题已在剪贴板。

export interface AiHubSite {
  id: string;
  name: string;
  home: string;
  /** 支持 ?q= 预填的站点：返回带问题的直达 URL；null 表示只能打开首页 */
  buildPromptUrl: ((text: string) => string) | null;
}

export const AI_HUB_SITES: AiHubSite[] = [
  { id: "deepseek", name: "DeepSeek", home: "https://chat.deepseek.com/", buildPromptUrl: null },
  { id: "gemini", name: "Gemini", home: "https://gemini.google.com/app", buildPromptUrl: null },
  {
    id: "chatgpt",
    name: "ChatGPT",
    home: "https://chatgpt.com/",
    buildPromptUrl: (text) => `https://chatgpt.com/?q=${encodeURIComponent(text)}`,
  },
  {
    id: "grok",
    name: "Grok",
    home: "https://grok.com/",
    buildPromptUrl: (text) => `https://grok.com/?q=${encodeURIComponent(text)}`,
  },
];

export const AI_HUB_SELECTION_KEY = "webconsole:ai-hub:sites";

export function findAiHubSite(id: string): AiHubSite | undefined {
  return AI_HUB_SITES.find((site) => site.id === id);
}

export function siteSupportsPromptUrl(id: string): boolean {
  return findAiHubSite(id)?.buildPromptUrl != null;
}

export function buildSiteOpenUrl(id: string, text: string): string {
  const site = findAiHubSite(id);
  if (!site) return "";
  if (text.trim() && site.buildPromptUrl) return site.buildPromptUrl(text.trim());
  return site.home;
}

// 勾选状态持久化：只保留合法站点 id，空/坏数据回退到前两个站点
export function normalizeSelection(raw: unknown): string[] {
  if (!Array.isArray(raw)) return AI_HUB_SITES.slice(0, 2).map((site) => site.id);
  const ids = raw.filter((id): id is string => typeof id === "string" && AI_HUB_SITES.some((site) => site.id === id));
  return ids.length > 0 ? ids : AI_HUB_SITES.slice(0, 2).map((site) => site.id);
}
