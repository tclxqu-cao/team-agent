import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SidebarDeleteConfirmation from "./SidebarDeleteConfirmation";

const baseProps = {
  message: "确定永久删除会话“测试会话”吗？此操作不可恢复。",
  anchor: { top: 100, left: 200, width: 28, height: 28 },
  mobile: false,
  pending: false,
  onCancel: () => undefined,
  onConfirm: () => undefined,
};

describe("SidebarDeleteConfirmation", () => {
  it("renders an anchored destructive confirmation with explicit actions", () => {
    const html = renderToStaticMarkup(createElement(SidebarDeleteConfirmation, baseProps));
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("确定永久删除会话");
    expect(html).toContain(">取消</button>");
    expect(html).toContain(">删除</button>");
    expect(html).not.toContain("is-mobile");
  });

  it("centers on mobile and disables actions while deletion is pending", () => {
    const html = renderToStaticMarkup(createElement(SidebarDeleteConfirmation, {
      ...baseProps,
      mobile: true,
      pending: true,
    }));
    expect(html).toContain("sidebar-delete-confirmation-layer is-mobile");
    expect(html.match(/disabled/g)).toHaveLength(2);
    expect(html).toContain("正在删除...");
  });
});
