import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NativeModelCatalogNotice from "./NativeModelCatalogNotice";

describe("native model catalog notice", () => {
  it("shows loading without offering overlapping retries", () => {
    const html = renderToStaticMarkup(createElement(NativeModelCatalogNotice, { status: "loading", error: null, onRetry: () => {} }));
    expect(html).toContain("模型加载中");
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<button");
  });

  it.each([
    ["empty", "暂无可选模型"],
    ["unsupported", "暂不支持选择模型"],
    ["error", "模型加载失败"],
  ] as const)("offers retry for %s catalogs", (status, label) => {
    const html = renderToStaticMarkup(createElement(NativeModelCatalogNotice, { status, error: "Login required", onRetry: () => {} }));
    expect(html).toContain(label);
    expect(html).toContain('aria-label="重新加载模型列表"');
    expect(html).toContain('type="button"');
    expect(html).toContain('title="Login required"');
    if (status === "error") expect(html).toContain('role="alert"');
  });

  it("leaves the successful model picker unobstructed", () => {
    expect(renderToStaticMarkup(createElement(NativeModelCatalogNotice, { status: "ready", error: null, onRetry: () => {} }))).toBe("");
  });
});
