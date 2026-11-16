import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SessionRunActivity from "./SessionRunActivity";

describe("SessionRunActivity", () => {
  it("uses a shimmering summary before the first activity block arrives", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: true,
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("正在处理这条消息");
    expect(html).toContain("execution-activity-block__preview--active");
    expect(html).not.toContain("思考");
    expect(html).not.toContain("持续了");
    expect(html).not.toContain("<svg");
  });

  it("does not restore the standalone thinking label from native progress", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: true,
      progress: { progressId: "thinking", phase: "thinking", label: "正在思考" },
    }));
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain("正在处理这条消息");
    expect(html).not.toContain("正在思考");
  });

  it("retains the run indicator when an individual native operation completes", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: true,
      progress: { progressId: "compaction", phase: "status", label: "上下文已压缩", status: "completed" },
    }));
    expect(html).toContain("正在处理这条消息");
    expect(html).toContain("execution-activity-block__preview--active");
    expect(html).not.toContain("上下文已压缩");
  });

  it("keeps a meaningful retry label in the same summary style", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: true,
      progress: { progressId: "retry", phase: "retry", label: "正在重新连接" },
    }));
    expect(html).toContain("正在重新连接");
    expect(html).toContain("execution-activity-block__preview--active");
  });

  it("hides activity after the turn stops even if native progress is stale", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: false,
      progress: { progressId: "thinking", phase: "thinking", label: "正在思考" },
    }));
    expect(html).toBe("");
  });
});
