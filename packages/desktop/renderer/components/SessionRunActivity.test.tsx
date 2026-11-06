import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SessionRunActivity from "./SessionRunActivity";

describe("SessionRunActivity", () => {
  it("keeps a running turn visible without native global progress, including tool and output gaps", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: true, startedAt: Date.now() - 2_000,
    }));
    expect(html).toContain('role="status"');
    expect(html).toContain("思考中");
    expect(html).toContain("持续了 2 秒");
    expect(html).toContain("agent-activity-icon");
  });

  it("shows native global progress once while it is running", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: true, startedAt: Date.now() - 2_000,
      progress: { progressId: "thinking", phase: "thinking", label: "正在思考" },
    }));
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain("正在思考");
    expect(html).toContain("持续了 2 秒");
  });

  it("retains the run indicator when an individual native operation completes", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: true, startedAt: Date.now() - 2_000,
      progress: { progressId: "compaction", phase: "status", label: "上下文已压缩", status: "completed" },
    }));
    expect(html).toContain("上下文已压缩");
    expect(html).toContain("思考中");
    expect(html).toContain("agent-activity-icon");
  });

  it("hides activity after the turn stops even if native progress is stale", () => {
    const html = renderToStaticMarkup(createElement(SessionRunActivity, {
      running: false, startedAt: Date.now(),
      progress: { progressId: "thinking", phase: "thinking", label: "正在思考" },
    }));
    expect(html).toBe("");
  });
});
