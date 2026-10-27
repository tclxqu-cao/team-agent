import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import HeaderActionMenu from "./HeaderActionMenu";

describe("header action overflow", () => {
  it("starts closed with an icon-only, named disclosure and mounted actions", () => {
    const html = renderToStaticMarkup(createElement(HeaderActionMenu, {
      children: createElement("button", { "aria-label": "我的文件" }),
    }));
    expect(html).toContain('aria-label="更多功能"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls=');
    expect(html).toMatch(/role="dialog"[^>]*hidden=""/);
    expect(html).toContain('aria-label="我的文件"');
    expect(html).not.toContain('>更多功能<');
  });
});
