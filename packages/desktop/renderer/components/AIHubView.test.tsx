import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AIHubView, { toggleHubSiteSelection } from "./AIHubView";

const source = readFileSync(new URL("./AIHubView.tsx", import.meta.url), "utf8");
const layoutSource = readFileSync(new URL("../lib/ai-hub-layout.ts", import.meta.url), "utf8");

describe("AIHubView", () => {
  it("degrades to a desktop-only notice when the hub bridge is missing", () => {
    const html = renderToStaticMarkup(createElement(AIHubView, { onExit: () => {} }));
    expect(html).toContain("AI Hub 仅在桌面端可用");
    expect(html).toContain("返回");
  });

  it("guards every native interaction behind the hub API surface", () => {
    expect(source).toContain('typeof api?.hubGetConfig === "function"');
    expect(source).toContain("window.agentApi");
    expect(source).not.toContain("window.electron");
  });

  it("pushes pane rects over IPC and hides all views on unmount", () => {
    expect(source).toContain("api?.hubSetBounds(panes)");
    expect(source).toContain("PANE_HEADER_HEIGHT");
    expect(source).toContain("void api.hubHideAll()");
    expect(source).toContain("new ResizeObserver");
    expect(source).toContain("requestAnimationFrame");
  });

  it("opens visible sites and falls back to an error layer with retry", () => {
    expect(source).toContain("api?.hubOpenSite(siteId)");
    expect(source).toContain("页面加载失败");
    expect(source).toContain("api?.hubReload(siteId)");
  });

  it("broadcasts to visible sites and surfaces per-site result chips", () => {
    expect(source).toContain("api.hubBroadcast(text, selectedIds, images)");
    expect(source).toContain("同步发送");
    expect(source).toContain('role="status"');
  });

  it("derives one-page and split layouts from the composer selection", () => {
    expect(source).toContain("MAX_COMPARE = 4");
    expect(source).toContain('data-aihub-site-picker=""');
    expect(source).toContain('aria-label="选择 AI 站点"');
    expect(source).toContain("selectedIds.length");
    expect(source).toContain("data-aihub-divider");
    expect(source).toContain("col-resize");
    expect(source).not.toContain('role="tablist"');
    expect(source).not.toContain("<aside");
    expect(layoutSource).toContain("export function computePaneRects");
    expect(layoutSource).toContain("export function normalizeRatios");
  });

  it("keeps one to four sites selected in selection order", () => {
    expect(toggleHubSiteSelection(["chatgpt"], "chatgpt")).toEqual(["chatgpt"]);
    expect(toggleHubSiteSelection(["chatgpt"], "gemini")).toEqual(["chatgpt", "gemini"]);
    expect(toggleHubSiteSelection(["chatgpt", "gemini"], "chatgpt")).toEqual(["gemini"]);
    expect(toggleHubSiteSelection(["a", "b", "c", "d"], "e")).toEqual(["a", "b", "c", "d"]);
  });

  it("uses a dedicated Google auth event instead of page-title detection", () => {
    expect(source).toContain('event.type === "google-auth-external"');
    expect(source).toContain("Google 登录已转至浏览器，内嵌请用邮箱");
    expect(source).not.toContain('event.title.includes("无法登录")');
    expect(source).not.toContain('event.title.includes("可能不安全")');
  });

  it("persists custom sites through the normalized config bridge", () => {
    expect(source).toContain("isValidHttpUrl");
    expect(source).toContain("hubSetConfig({ version: 1, sites: [...sites, site] })");
    expect(source).toContain('adapter: "generic"');
    expect(source).toContain('site.id.startsWith("custom-")');
  });

  it("offers existing Chrome setup and page panes without the temporary-profile sync flow", () => {
    expect(source).toContain("连接 Chrome");
    expect(source).toContain("ChromeHubPane");
    expect(source).toContain("ChromeHubSetup");
    expect(source).toContain("hubOpenChrome(siteId)");
    expect(source).not.toContain("hubStartGoogleReauth");
    expect(source).not.toContain("hubSyncGoogleReauth");
  });
});
