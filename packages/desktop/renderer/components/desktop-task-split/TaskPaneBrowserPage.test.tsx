import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import TaskPaneBrowserPage, { taskPaneBrowserSandbox, taskPaneBrowserUrl } from "./TaskPaneBrowserPage";

describe("browser workspace website previews", () => {
  it("limits iframe previews to absolute HTTP(S) URLs", () => {
    expect(taskPaneBrowserUrl("https://example.com/path?q=1")).toBe("https://example.com/path?q=1");
    for (const value of ["javascript:alert(1)", "data:text/html,test", "file:///private/file", "//example.com", "/app/"]) expect(taskPaneBrowserUrl(value)).toBeNull();
    const invalid = renderToStaticMarkup(createElement(TaskPaneBrowserPage, { paneId: "a", url: "javascript:alert(1)" }));
    expect(invalid).not.toContain("<iframe");
    expect(invalid).toContain("只能预览 HTTP 或 HTTPS 网页");
  });

  it("keeps external content sandboxed and provides an explicit browser escape hatch", () => {
    const html = renderToStaticMarkup(createElement(TaskPaneBrowserPage, { paneId: "a", url: "https://example.com/page" }));
    expect(html).toContain('src="https://example.com/page"');
    expect(html).toContain('sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain('referrerPolicy="no-referrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("若网站限制内嵌或页面无法登录");
  });

  it("preserves external sites' origins while keeping app-origin frames opaque", () => {
    const host = "http://100.121.10.115:3000";
    expect(taskPaneBrowserSandbox("https://example.com/app", host)).toContain("allow-same-origin");
    expect(taskPaneBrowserSandbox(`${host}/app/`, host)).not.toContain("allow-same-origin");
    expect(taskPaneBrowserSandbox("https://example.com/app", "null")).not.toContain("allow-same-origin");
    expect(taskPaneBrowserSandbox("javascript:alert(1)", host)).not.toContain("allow-same-origin");
    expect(taskPaneBrowserSandbox("https://example.com/app", host)).not.toContain("allow-top-navigation");
  });

  it("hides a background pane without removing its iframe state", () => {
    const html = renderToStaticMarkup(createElement(TaskPaneBrowserPage, { paneId: "a", url: "https://example.com", visible: false }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("visibility:hidden");
    expect(html).toContain("<iframe");
  });
});
