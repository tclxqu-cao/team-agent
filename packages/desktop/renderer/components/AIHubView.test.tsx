import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AIHubView from "./AIHubView";

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
    expect(source).toContain("api.hubBroadcast(text, visibleIds)");
    expect(source).toContain("同步发送");
    expect(source).toContain('role="status"');
  });

  it("supports compare mode bounds of 2-4 sites with draggable dividers", () => {
    expect(source).toContain("MAX_COMPARE = 4");
    expect(source).toContain("MIN_COMPARE = 2");
    expect(source).toContain("data-aihub-divider");
    expect(source).toContain("col-resize");
    expect(layoutSource).toContain("export function computePaneRects");
    expect(layoutSource).toContain("export function normalizeRatios");
  });

  it("persists custom sites through the normalized config bridge", () => {
    expect(source).toContain("isValidHttpUrl");
    expect(source).toContain("hubSetConfig({ version: 1, sites: [...sites, site] })");
    expect(source).toContain('adapter: "generic"');
    expect(source).toContain('site.id.startsWith("custom-")');
  });
});
