import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RuntimeProgressRow from "./RuntimeProgressRow";

describe("RuntimeProgressRow", () => {
  it("uses the shared brain icon for global thinking progress", () => {
    const html = renderToStaticMarkup(createElement(RuntimeProgressRow, {
      progress: {
        progressId: "thinking",
        phase: "thinking",
        label: "正在思考",
      },
      startedAt: Date.now() - 2_000,
    }));

    expect(html).toContain("runtime-progress-row__brain");
    expect(html).not.toContain("runtime-progress-row__spinner");
    expect(html).toContain("持续了 2 秒");
  });

  it("uses a full-size activity icon while the runtime starts processing", () => {
    const html = renderToStaticMarkup(createElement(RuntimeProgressRow, {
      progress: {
        progressId: "status",
        phase: "status",
        label: "正在开始处理",
      },
    }));

    expect(html).toContain("runtime-progress-row__status-icon");
    expect(html).toContain("正在开始处理");
    expect(html).not.toContain("runtime-progress-row__spinner");
  });

  it("keeps the loading spinner for compact tool progress", () => {
    const html = renderToStaticMarkup(createElement(RuntimeProgressRow, {
      progress: {
        progressId: "tool",
        phase: "tool",
        label: "正在执行",
        toolCallId: "call-1",
      },
      compact: true,
    }));

    expect(html).toContain("runtime-progress-row__spinner");
    expect(html).not.toContain("runtime-progress-row__brain");
  });
});
