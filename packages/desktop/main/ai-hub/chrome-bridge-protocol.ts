export const CHROME_HUB_SITES = ["chatgpt", "gemini", "grok"] as const;
export type ChromeHubSiteId = typeof CHROME_HUB_SITES[number];
export const CHROME_HUB_ORIGINS: Record<ChromeHubSiteId, string> = {
  chatgpt: "https://chatgpt.com", gemini: "https://gemini.google.com", grok: "https://grok.com",
};
export function isChromeHubSite(value: string): value is ChromeHubSiteId {
  return CHROME_HUB_SITES.includes(value as ChromeHubSiteId);
}
export function chromeHubSiteForUrl(value: string): ChromeHubSiteId | null {
  try {
    const url = new URL(value);
    // 认证页面始终留在普通 Chrome 中，禁止截图或远程输入。
    if (/^\/(auth|login|signin|sign-in|signup|sign-up)(\/|$)/i.test(url.pathname)) return null;
    return CHROME_HUB_SITES.find((site) => CHROME_HUB_ORIGINS[site] === url.origin) ?? null;
  } catch { return null; }
}
export interface ChromeHubTab {
  siteId: ChromeHubSiteId;
  tabId: number;
  url: string;
}
export interface ChromeHubStatus {
  compatible?: boolean;
  paused?: boolean;
  connected: boolean;
  tabs: ChromeHubTab[];
}
export interface ChromeHubFrame {
  siteId: ChromeHubSiteId;
  data: string;
  width: number;
  height: number;
}
export type ChromeHubInput =
  | { kind: "pointer"; action: "down" | "up" | "move" | "wheel"; x: number; y: number; deltaX?: number; deltaY?: number; button?: "left" | "right" | "middle" }
  | { kind: "key"; action: "down" | "up"; key: string; code: string; modifiers: number }
  | { kind: "text"; text: string };
export function validChromeHubInput(input: unknown): input is ChromeHubInput {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  if (value.kind === "text") return typeof value.text === "string" && value.text.length <= 100_000;
  if (value.kind === "key") return ["down", "up"].includes(String(value.action))
    && typeof value.key === "string" && value.key.length <= 64 && typeof value.code === "string" && value.code.length <= 64
    && Number.isInteger(value.modifiers) && Number(value.modifiers) >= 0 && Number(value.modifiers) <= 15;
  return value.kind === "pointer" && ["down", "up", "move", "wheel"].includes(String(value.action))
    && [value.x, value.y].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1)
    && [value.deltaX, value.deltaY].every((n) => n === undefined || (typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 100_000))
    && (value.button === undefined || ["left", "right", "middle"].includes(String(value.button)));
}

export interface ChromeHubMessage { id: string; role: "user" | "assistant"; content: string }
export interface ChromeHubConversation {
  siteId: ChromeHubSiteId;
  conversationId: string;
  revision: number;
  messages: ChromeHubMessage[];
  generating: boolean;
  composerAvailable: boolean;
  receivedAt: number;
}
export function validChromeConversation(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const c = value as Record<string, unknown>;
  if (typeof c.conversationId !== "string" || c.conversationId.length > 512 || !Number.isSafeInteger(c.revision) || Number(c.revision) < 1
    || typeof c.generating !== "boolean" || typeof c.composerAvailable !== "boolean" || !Array.isArray(c.messages) || c.messages.length > 100) return false;
  const ids = new Set<string>();
  let size = 0;
  return c.messages.every((m) => {
    if (!m || typeof m.id !== "string" || m.id.length > 512 || ids.has(m.id) || !["user", "assistant"].includes(m.role) || typeof m.content !== "string" || m.content.length > 50_000) return false;
    ids.add(m.id); size += m.content.length;
    return size <= 1_000_000;
  });
}
export function chromeHubErrorMessage(reason: string): string {
  const geminiError = /^chrome-gemini-error-(\d{1,6})$/.exec(reason);
  if (geminiError) return `Gemini 网页拒绝发送（错误 ${geminiError[1]}），请刷新该网页或新建对话后重试`;
  const messages: Record<string, string> = {
    "chrome-auth-required": "请在 Chrome 完成登录后重新连接",
    "chrome-tab-disconnected": "标签页未连接，请打开站点并确认扩展自动连接未暂停",
    "chrome-input-not-found": "未找到网页输入框，请打开 Chrome 检查页面",
    "chrome-existing-draft": "网页已有未发送草稿，请先处理草稿",
    "chrome-generating": "网页仍在生成上一条回复，请稍后发送",
    "chrome-input-not-applied": "文字未写入网页输入框，请打开 Chrome 检查",
    "chrome-send-obscured": "网页发送按钮被弹窗遮挡，请先处理 Chrome 中的弹窗",
    "chrome-send-disabled": "网页发送按钮暂不可用，请检查附件或站点限制",
    "chrome-submit-unconfirmed": "尚未确认网页收到消息，请先检查原网页，避免重复发送",
    "chrome-conversation-changed": "网页已切换会话，本次未提交",
    "chrome-command-timeout": "网页操作超时，请检查 Chrome 标签页",
    "chrome-page-loading": "网页正在加载，请稍后重试",
    "chrome-upload-unavailable": "网页图片上传入口不可用，请在 Chrome 上传",
    "chrome-conversation-unavailable": "暂时无法读取回复，正在重试",
  };
  return messages[reason] ?? (reason.startsWith("chrome-") ? "网页操作未完成，请打开 Chrome 检查" : reason);
}
