import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import CollaborationPane from "./CollaborationPane";

vi.mock("./FlowStudioLoading", () => ({
  default: ({ title, caption }: { title: string; caption: string }) => createElement("div", { role: "status" }, title, caption),
}));

// Next preserves JSX for its compiler; the root Vitest runner uses classic JSX.
beforeAll(() => vi.stubGlobal("React", React));
afterAll(() => vi.unstubAllGlobals());

describe("group entry loading surface", () => {
  it("uses the same entry animation for the dashboard while its saved groups load", () => {
    const html = renderToStaticMarkup(createElement(CollaborationPane, { title: "群聊看板", onFrame: vi.fn(), onLoad: vi.fn() }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在打开群聊列表");
    expect(html).toContain("正在加载已保存的群聊");
    expect(html).toContain('visibility:hidden');
    expect(html).toContain('/app/?view=collaboration-dashboard');
  });

  it("loads the independent session Dashboard and carries an explicit source discussion", () => {
    const dashboard = renderToStaticMarkup(createElement(CollaborationPane, { view: "sessions", title: "Dashboard", onFrame: vi.fn(), onLoad: vi.fn() }));
    expect(dashboard).toContain("/app/?view=session-dashboard");
    expect(dashboard).toContain("正在打开会话 Dashboard");
    const group = renderToStaticMarkup(createElement(CollaborationPane, { groupId: "g", discussionId: "older-active", title: "群聊", onFrame: vi.fn(), onLoad: vi.fn() }));
    expect(group).toContain("discussionId=older-active");
  });

  it("immediately shows the shared loader and conceals the iframe until its content is ready", () => {
    const html = renderToStaticMarkup(createElement(CollaborationPane, { groupId: "g", title: "协作群", onFrame: vi.fn(), onLoad: vi.fn() }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在进入群聊");
    expect(html).toContain("正在加载群成员与聊天记录");
    expect(html).toContain('visibility:hidden');
    expect(html).toContain('/app/?view=collaboration&amp;groupId=g');
    expect(html).not.toContain('role="alert"');
  });
});
