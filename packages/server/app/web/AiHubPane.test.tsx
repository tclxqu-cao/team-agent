import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import AiHubPane from "./AiHubPane";

const source = readFileSync(new URL("./AiHubPane.tsx", import.meta.url), "utf8");
const sitesSource = readFileSync(new URL("./aiHubSites.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");
const fileTree = readFileSync(new URL("./FileTree.tsx", import.meta.url), "utf8");

describe("AiHubPane", () => {
  it("hydrates to nothing during SSR render (localStorage gate)", () => {
    expect(source).toContain("useState<string[]>(() => AI_HUB_SITES.slice(0, 2)");
    expect(source).toContain("setHydrated(true)");
  });

  it("persists selection and copies the prompt for non ?q= sites", () => {
    expect(source).toContain("AI_HUB_SELECTION_KEY");
    expect(source).toContain("navigator.clipboard.writeText");
    expect(source).toContain("document.execCommand(\"copy\")");
  });

  it("sends via new tabs: ?q= direct send, others open home with clipboard", () => {
    expect(source).toContain("buildSiteOpenUrl(id, text)");
    expect(sitesSource).toContain("https://chatgpt.com/?q=");
    expect(sitesSource).toContain("https://grok.com/?q=");
    expect(sitesSource).toContain("buildPromptUrl: null");
    expect(source).toContain('window.open(url, "_blank", "noopener")');
  });

  it("keeps a manual per-pane open button as the popup-blocker fallback", () => {
    expect(source).toContain("被拦截");
    expect(source).toContain("打开");
  });

  it("auto-splits into equal columns per selected site (max 4)", () => {
    expect(source).toContain("Math.min(Math.max(selected.length, 1), 4)");
    expect(source).toContain("gridTemplateColumns");
    // 等宽分屏：1fr 网格 + 主题变量作为分割线
    expect(source).toContain("repeat(${columns}, 1fr)");
    expect(source).toContain("var(--ui-muted-border)");
  });

  it("no longer embeds iframes; panes are status boards and the answer lives in the desktop hub", () => {
    expect(source).not.toContain("<iframe");
    expect(source).not.toContain("白屏属正常");
    expect(source).toContain("回答在桌面端生成");
  });

  it("moves the composer to the bottom, below the split panes", () => {
    const panesIndex = source.indexOf("等宽分屏");
    const composerIndex = source.lastIndexOf("底部输入台");
    expect(panesIndex).toBeGreaterThan(-1);
    expect(composerIndex).toBeGreaterThan(panesIndex);
    expect(source.indexOf('flex: 1,\n          minHeight: 0,\n          display: "grid"')).toBeGreaterThan(-1);
  });

  it("composer supports image upload with count and size caps", () => {
    expect(source).toContain("MAX_IMAGES = 4");
    expect(source).toContain("MAX_IMAGE_BYTES = 5 * 1024 * 1024");
    expect(source).toContain('accept="image/*"');
    expect(source).toContain("readImageAsDataUrl");
    expect(source).toContain('aria-label="添加图片"');
  });

  it("collapses model selection into an upward multi-select dropdown inside the composer", () => {
    // 旧的多选 chips 行已移除，改为输入框内的下拉
    expect(source).not.toContain("aria-pressed");
    expect(source).toContain('aria-label="选择 AI 站点"');
    expect(source).toContain('aria-haspopup="listbox"');
    // composer 在页面底部，下拉必须向上展开
    expect(source).toContain('bottom: "calc(100% + 8px)"');
    // 下拉项仍是多选（aria-selected + toggleSite）
    expect(source).toContain('aria-selected={active}');
    const pickerBody = source.slice(source.indexOf("pickerOpen && ("), source.indexOf("</button>\n\n          <div style={{ flex: 1"));
    expect(pickerBody).toContain("toggleSite(site.id)");
  });

  it("centers the composer placeholder vertically in the input row", () => {
    const composerIndex = source.lastIndexOf("底部输入台");
    const inputRow = source.slice(composerIndex).indexOf('alignItems: "center"');
    expect(inputRow).toBeGreaterThan(-1);
    expect(source).not.toContain('alignItems: "flex-end"');
  });

  it("keeps the textarea at 16px so iOS Safari does not zoom the page on focus", () => {
    const textareaStart = source.indexOf("<textarea");
    const textareaEnd = source.indexOf("/>", textareaStart);
    const block = source.slice(textareaStart, textareaEnd);
    expect(block).toContain("fontSize: 16");
  });

  it("shows immediate feedback when a relay send starts", () => {
    const sendBody = source.slice(source.indexOf("const send = useCallback"), source.indexOf("const columns = useMemo"));
    const noticeIndex = sendBody.indexOf("正在通过桌面端向");
    const rpcIndex = sendBody.indexOf('rpc<RelaySendResponse>');
    expect(noticeIndex).toBeGreaterThan(-1);
    expect(noticeIndex).toBeLessThan(rpcIndex);
  });

  it("polls desktop conversation capture and renders per-pane transcripts", () => {
    expect(source).toContain('rpc<RelayCaptureResponse>("aihub:capture", { siteIds: selected }, 12000)');
    expect(source).toContain("PaneTranscript");
    expect(source).toContain('data-aihub-transcript=""');
    expect(source).toContain('data-aihub-msg-role={message.role}');
    // 轮询仅在页签可见且中继在线时进行
    expect(source).toContain('if (relay !== "online" || !rpc || !visible || selected.length === 0) return;');
  });

  it("surfaces a login hint when a site page yields no extractable conversation", () => {
    expect(source).toContain('captureMeta[id]?.strategy === "none"');
    expect(source).toContain("站点未登录或页面未就绪");
  });

  it("relays text + images through the desktop app when online, before any await", () => {
    expect(source).toContain('rpc<{ available: boolean }>("aihub:status", undefined, 6000)');
    expect(source).toContain('rpc<RelaySendResponse>("aihub:send", { text, siteIds: selected, images: imagePayload }, 60000)');
    // 中继分支必须出现在浏览器直发（window.open）之前
    const sendBody = source.slice(source.indexOf("const send = useCallback"), source.indexOf("const columns = useMemo"));
    const relayIndex = sendBody.indexOf('if (relay === "online" && rpc)');
    const openIndex = sendBody.indexOf("window.open(url");
    expect(relayIndex).toBeGreaterThan(-1);
    expect(relayIndex).toBeLessThan(openIndex);
    expect(source).toContain("已通过桌面端向");
  });

  it("falls back to browser tabs and marks the relay offline when unavailable", () => {
    expect(source).toContain("桌面端中继不可用");
    expect(source).toContain("setRelay(\"offline\")");
    expect(source).toContain("window.open(url, \"_blank\", \"noopener\")");
    expect(source).toContain("被拦截");
  });

  it("blocks image-only sends on the browser fallback path (images need the desktop relay)", () => {
    const sendBody = source.slice(source.indexOf("const send = useCallback"), source.indexOf("const columns = useMemo"));
    const imageGuardIndex = sendBody.indexOf("图片只能经桌面端注入");
    const openIndex = sendBody.indexOf("window.open(url");
    expect(imageGuardIndex).toBeGreaterThan(-1);
    expect(imageGuardIndex).toBeLessThan(openIndex);
  });

  it("opens tabs synchronously inside the user gesture, then copies to clipboard", () => {
    // iOS Safari：await 之后再 window.open 会因手势失效被弹窗拦截
    const sendBody = source.slice(source.indexOf("const send = useCallback"), source.indexOf("const columns = useMemo"));
    const openIndex = sendBody.indexOf("window.open(url");
    const awaitIndex = sendBody.indexOf("copyText(text)");
    expect(openIndex).toBeGreaterThan(-1);
    expect(awaitIndex).toBeGreaterThan(openIndex);
    expect(sendBody).not.toContain("await ");
  });

  it("opens from an icon button adjacent to the file-tree toggle in the tab strip", () => {
    expect(page).toContain('kind: "aihub"');
    expect(page).toContain("const AI_HUB_TAB = { id: \"ai-hub\", title: \"AI Hub\", kind: \"aihub\" } as const;");
    expect(page).toContain("<AiHubPane visible={tab.id === activeTerminalId} rpc={rpc} />");
    expect(page).toContain('closingKind !== "aihub"');
    // 文件树抽屉内部不放入口；图标在外面紧挨文件树开关（PanelRight）
    expect(fileTree).not.toContain("onOpenAiHub");
    const aiHubButton = page.indexOf('aria-label="打开 AI Hub"');
    const drawerToggle = page.indexOf('aria-label={drawerOpen ? "关闭我的文件" : "打开我的文件"}');
    expect(aiHubButton).toBeGreaterThan(-1);
    expect(aiHubButton).toBeLessThan(drawerToggle);
  });
});
