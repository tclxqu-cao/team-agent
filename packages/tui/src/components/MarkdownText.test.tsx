import React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "ink-testing-library";
import { MarkdownText } from "./MarkdownText.js";

afterEach(() => cleanup());

describe("MarkdownText", () => {
  it("renders headings, emphasis, code, and nested lists without source markers", () => {
    const view = render(
      <MarkdownText>{[
        "## 主要信息",
        "",
        "- **技术栈**：`Vue 2`",
        "  - Vuex",
        "- **核心业务**：赔付录入",
      ].join("\n")}</MarkdownText>,
    );
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("主要信息");
    expect(frame).toContain("• 技术栈：Vue 2");
    expect(frame).toContain("  • Vuex");
    expect(frame).toContain("• 核心业务：赔付录入");
    expect(frame).not.toContain("##");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("`Vue 2`");
  });
});
