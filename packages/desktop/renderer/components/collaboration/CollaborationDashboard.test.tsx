import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { groupFixture } from "../../../../core/src/domain/collaboration/__tests__/fixtures";
import CollaborationDashboard from "./CollaborationDashboard";

const fixture = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("./CollaborationCreateDialog", () => ({ default: () => null }));
vi.mock("./useCollaborationGroups", () => ({ useCollaborationGroups: () => fixture.value }));

describe("group dashboard", () => {
  it("shows server-persisted groups with open, edit and delete controls", () => {
    fixture.value = { groups: [groupFixture()], loading: false, error: "", refresh: vi.fn() };
    const html = renderToStaticMarkup(createElement(CollaborationDashboard));
    expect(html).toContain("协作群");
    expect(html).toContain('aria-label="修改协作群"');
    expect(html).toContain('aria-label="删除协作群"');
    expect(html).toContain("进入群聊");
    expect(html).toContain("/project");
    expect(html).toContain("群主 · ");
    expect(html).toContain("总控");
  });
  it("distinguishes loading, empty data and a failed list request", () => {
    fixture.value = { groups: [], loading: true, error: "", refresh: vi.fn() };
    expect(renderToStaticMarkup(createElement(CollaborationDashboard))).toContain("正在加载已保存的群");
    fixture.value = { ...fixture.value, loading: false };
    expect(renderToStaticMarkup(createElement(CollaborationDashboard))).toContain("新建第一个群");
    fixture.value = { ...fixture.value, error: "无法连接服务" };
    const html = renderToStaticMarkup(createElement(CollaborationDashboard));
    expect(html).toContain("重试");
    expect(html).not.toContain("新建第一个群");
  });
});
