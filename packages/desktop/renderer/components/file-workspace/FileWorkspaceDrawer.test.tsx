import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FileWorkspaceGateway } from "../../../../core/src/application/file-workspace/FileWorkspaceGateway";
import FileWorkspaceDrawer from "./FileWorkspaceDrawer";

const gateway: FileWorkspaceGateway = {
  request: vi.fn(async () => ({})),
  subscribe: vi.fn(() => () => {}),
};

const baseProps = {
  open: true,
  tab: "files" as const,
  gateway,
  cwd: "/work/project",
  selectedPath: null,
  revealRequest: null,
  onTabChange: () => {},
  onSelectPath: () => {},
  onClose: () => {},
};

describe("FileWorkspaceDrawer", () => {
  it("does not render while closed", () => {
    expect(renderToStaticMarkup(createElement(FileWorkspaceDrawer, { ...baseProps, open: false }))).toBe("");
  });

  it("renders file and history tabs without duplicating the workspace path in the header", () => {
    const html = renderToStaticMarkup(createElement(FileWorkspaceDrawer, baseProps));
    expect(html).toContain('aria-label="我的文件"');
    expect(html).not.toContain("desktop-file-drawer-cwd");
    expect(html).toContain('class="desktop-file-workspace-close ui-icon-button ui-icon-button--small"');
    expect(html).toContain('aria-label="关闭我的文件"');
    expect(html).toContain('title="关闭"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("实时同步");
  });

  it("explains the missing terminal context instead of exposing chat actions", () => {
    const html = renderToStaticMarkup(createElement(FileWorkspaceDrawer, { ...baseProps, tab: "history" }));
    expect(html).toContain("终端历史在 Web 控制台中可用");
    expect(html).toContain("Electron 当前没有终端上下文");
    expect(html).not.toContain("填入命令");
  });

  it("shows a no-workspace state", () => {
    const html = renderToStaticMarkup(createElement(FileWorkspaceDrawer, { ...baseProps, cwd: null }));
    expect(html).toContain("请先选择一个项目目录");
  });
});
