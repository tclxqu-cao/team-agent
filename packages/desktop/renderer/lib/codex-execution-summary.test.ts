import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { codexExecutionTurnDurations } from "./codex-execution-summary";
import { formatSessionWorkDuration } from "./session-execution-summary";

const message = (id: string, value: Partial<ChatMessage> = {}): ChatMessage => ({
  id, role: "assistant", content: "", timestamp: 1, ...value,
});

describe("Codex execution completion summaries", () => {
  it("keeps seconds visible on the live clock after minute and hour boundaries", () => {
    expect(formatSessionWorkDuration(60_000, true)).toBe("已工作 1 分 0 秒");
    expect(formatSessionWorkDuration(3_661_000, true)).toBe("已工作 1 时 1 分 1 秒");
    expect(formatSessionWorkDuration(3_661_000)).toBe("已工作 1 时 1 分");
  });

  it("uses completion timing for each turn, including multiple same-turn input segments", () => {
    const durations = codexExecutionTurnDurations([
      message("user", { role: "user" }),
      message("trace-1", { executionTrace: { turnId: "turn-1", revision: "rev" } }),
      message("follow-up", { role: "user", presentation: { executionTrace: { turnId: "turn-1", segmentIndex: 1 } } }),
      message("trace-2", { executionTrace: { turnId: "turn-1", segmentIndex: 1, revision: "rev" } }),
      message("answer-1", { presentation: { completionDurationMs: 565_000 } }),
      message("user-2", { role: "user" }),
      message("trace-3", { executionTrace: { turnId: "turn-2", revision: "rev" } }),
      message("answer-2", { presentation: { completionDurationMs: 12_000 } }),
      message("other-user", { role: "user" }),
      message("other-answer", { presentation: { completionDurationMs: 99_000 } }),
    ]);
    expect([...durations]).toEqual([["turn-1", 565_000], ["turn-2", 12_000]]);
  });

  it("honors native ownership and does not invent timing from message timestamps", () => {
    expect([...codexExecutionTurnDurations([
      message("trace", { executionTrace: { turnId: "latest", revision: "rev" } }),
      message("answer", { timestamp: 999_999, presentation: {
        executionTrace: { turnId: "original" }, completionDurationMs: 0,
      } }),
      message("missing-duration", { timestamp: 999_999 }),
    ])]).toEqual([["original", 0]]);
  });

  it("reads native completion timing and answerless run results from their owning user input", () => {
    expect([...codexExecutionTurnDurations([
      message("user", { role: "user", presentation: {
        executionTrace: { turnId: "native", segmentIndex: 0 }, completionDurationMs: 2967665,
      } }),
      message("follow-up", { role: "user", presentation: { executionTrace: { turnId: "native", segmentIndex: 1 } } }),
      message("failed-user", { role: "user", presentation: {
        executionTrace: { turnId: "failed" },
        runResult: { status: "failed", reason: "auth_required", durationMs: 2000 },
      } }),
      message("unowned-user", { role: "user", presentation: { completionDurationMs: 9000 } }),
      message("untimed-user", { role: "user", presentation: { executionTrace: { turnId: "untimed" } } }),
    ])]).toEqual([["native", 2967665], ["failed", 2000]]);
  });

  it.each([
    [6_480_000, "已工作 1 时 48 分"],
    [3_600_000, "已工作 1 时 0 分"],
    [565_000, "已工作 9 分 25 秒"],
    [60_000, "已工作 1 分"],
    [12_500, "已工作 13 秒"],
    [0, "已工作 0 秒"],
    [undefined, "已工作"],
    [-1, "已工作"],
    [Number.NaN, "已工作"],
    [Number.POSITIVE_INFINITY, "已工作"],
  ])("formats %s without fabricating an elapsed duration", (value, expected) => {
    expect(formatSessionWorkDuration(value)).toBe(expected);
  });
});
