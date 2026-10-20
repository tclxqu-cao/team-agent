import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import SidebarRefreshButton from "./SidebarRefreshButton";

const render = (loading: boolean, error: string | null = null) => renderToStaticMarkup(
  createElement(SidebarRefreshButton, { loading, error, onRefresh: () => undefined }),
);

describe("directory refresh feedback", () => {
  it("spins and disables only while directories are loading", () => {
    const html = render(true);
    expect(html).toContain("animate-spin");
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="正在加载目录"');
  });

  it("returns to the same refresh control after completion", () => {
    const html = render(false);
    expect(html).not.toContain("animate-spin");
    expect(html).not.toContain("disabled");
    expect(html).toContain('aria-label="刷新目录"');
  });

  it("offers retry and a small marker on failure without spinning", () => {
    const html = render(false, "网络不可用");
    expect(html).toContain("sidebar-directory-refresh-error");
    expect(html).toContain("网络不可用");
    expect(html).toContain("点击重试");
    expect(html).not.toContain("disabled");
    expect(render(true, "旧错误")).not.toContain("sidebar-directory-refresh-error");
  });

  it("keeps directory and session feedback separate and uses skeletons for first load", () => {
    const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
    expect(app).toContain("loading={workspaceLoading}");
    expect(app).not.toContain("workspaceLoading || loadingProjectIds.size");
    expect(app).not.toContain("正在同步目录...");
    expect(app).not.toContain("正在加载目录...");
    expect(app).toContain("sidebar-directory-skeleton");
    expect(app).toContain("正在加载会话...");
  });
});
