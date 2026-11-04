import type { RunResult } from "@agent/core";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import RunResultSummary from "./RunResultSummary";

const render = (result: RunResult) => renderToStaticMarkup(createElement(RunResultSummary, { result }));
const base: RunResult = { status: "completed", reason: "completed", durationMs: 1_000 };

describe("RunResultSummary", () => {
  it.each([
    ["completed", "completed", "已完成"],
    ["failed", "quota_exceeded", "运行失败：额度不足"],
    ["cancelled", "user_cancelled", "已停止"],
    ["interrupted", "runtime_interrupted", "已中断：运行环境中断"],
  ] as const)("renders a safe %s summary with explicit unknown usage", (status, reason, label) => {
    const html = render({ ...base, status, reason });
    expect(html).toContain('role="status"');
    expect(html).toContain(label);
    expect(html).toContain("总耗时 1 秒");
    expect(html).toContain("token 未知");
    expect(html).not.toContain("美元");
    expect(html).not.toContain("$");
  });

  it("shows partial usage and does not display unknown provider payloads", () => {
    const html = render({ ...base, status: "failed", reason: "unknown_error", usage: {
      inputTokens: 120, outputTokens: 30, totalTokens: 150, coverage: "partial", source: "runtime",
    }, ...{ error: "RAW_ERROR_WITH_SECRET" } });
    expect(html).toContain("输入 120 / 输出 30 token（部分统计）");
    expect(html).not.toContain("RAW_ERROR_WITH_SECRET");
  });

  it("does not present execution limits with a green success check", () => {
    const html = render({ ...base, reason: "tool_cycle" });
    expect(html).toContain("已结束：已停止重复的工具调用");
    expect(html).toContain("msg-run-result--limited");
    expect(html).toContain("lucide-circle-alert");
    expect(html).not.toContain("lucide-check");
  });

  it("wires results into live message presentation and the existing footer without synthesizing history status", () => {
    const source = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
    expect(source).toContain("applyRunResult(resultEvent, eventSid)");
    expect(source).toContain("authoritativeRunResultEvent(runTerminal, event)");
    expect(source).toContain("firstRunTerminalEvent(first, event)");
    expect(source).toContain("(runResult || actionPolicy.showCompletion)");
    expect(source).toContain("<RunResultSummary result={runResult} />");
    expect(source).not.toContain("<span>已完成</span>");
  });
});
