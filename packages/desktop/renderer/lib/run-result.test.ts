import type { RunResult } from "@agent/core";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import {
  applyRunResultToMessages,
  authoritativeRunResultEvent,
  eventRunResult,
  firstRunTerminalEvent,
  formatRunResultSummary,
  latestRunTerminalEvent,
  mergeRunResult,
  runResultTargetMessage,
} from "./run-result";

const failed: RunResult = { status: "failed", reason: "quota_exceeded", durationMs: 1_200, runId: "r1" };
const success: RunResult = { status: "completed", reason: "completed", durationMs: 2_600, runId: "r2" };
const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 80, coverage: "partial" as const };
const message = (id: string, role: ChatMessage["role"], content: string, extra: Partial<ChatMessage> = {}): ChatMessage => (
  { id, role, content, timestamp: 1, ...extra }
);

describe("renderer run result projection", () => {
  it("attaches a no-output failure to its user, not a prior answer or a queued input", () => {
    const messages = [message("u0", "user", "old"), message("a0", "assistant", "old answer"),
      message("u1", "user", "new"), message("q", "user", "queued", { isQueued: true })];
    const projected = applyRunResultToMessages(messages, { type: "error", result: failed });
    expect(projected).toHaveLength(messages.length);
    expect(projected[2].presentation?.runResult).toEqual(failed);
    expect(projected[1].presentation?.runResult).toBeUndefined();
    expect(projected[3].presentation?.runResult).toBeUndefined();
    expect(messages[2].presentation).toBeUndefined();
  });

  it("uses the actual current assistant output while preserving its presentation", () => {
    const messages = [message("u", "user", "new"), message("a", "assistant", "partial", {
      presentation: { rawContent: "kept", reasoning: [{ itemId: "reason", sectionIndex: 0, text: "thinking" }] },
    }), message("steer", "user", "also", { isSteered: true })];
    const projected = applyRunResultToMessages(messages, { type: "error", result: failed });
    expect(projected[1].presentation).toMatchObject({ rawContent: "kept", runResult: failed });
    expect(projected[2].presentation).toBeUndefined();
  });

  it("falls back to the user when Codex only has commentary or a trace disclosure", () => {
    const messages = [message("u", "user", "run"), message("trace", "assistant", "", {
      executionTrace: { turnId: "t", revision: "v1" },
    }), message("comment", "assistant", "checking", { presentation: { agentMessagePhase: "commentary" } })];
    expect(runResultTargetMessage(messages)?.id).toBe("u");
    expect(applyRunResultToMessages([], { type: "error", result: failed })).toEqual([]);
  });

  it("keeps tool-only and reasoning-only work on the owning user footer", () => {
    const messages = [message("u", "user", "run"),
      message("tool", "assistant", "", { toolCalls: [{ id: "t", name: "read_file", arguments: {} }] }),
      message("reason", "assistant", "", { presentation: { reasoning: [{ itemId: "r", sectionIndex: 0, text: "thinking" }] } })];
    expect(applyRunResultToMessages(messages, { type: "error", result: failed })[0].presentation?.runResult).toEqual(failed);
    expect(runResultTargetMessage(messages)?.id).toBe("u");
  });

  it("keeps the first terminal status and duration but accepts missing reported usage", () => {
    const messages = [message("u", "user", "run"), message("a", "assistant", "partial")];
    const first = applyRunResultToMessages(messages, { type: "error", result: failed });
    const next = applyRunResultToMessages(first, { type: "done", result: { ...success, runId: "r1", usage } });
    expect(next[1].presentation?.runResult).toEqual({ ...failed, usage });
    expect(mergeRunResult(failed, success)).toEqual(success);
    const later = [...next, message("u2", "user", "retry"), message("a2", "assistant", "ok")];
    expect(applyRunResultToMessages(later, { type: "done", result: success })[3].presentation?.runResult).toEqual(success);
    expect(applyRunResultToMessages(later, { type: "done", result: { ...success, runId: "r1" } })[1].presentation?.runResult?.status).toBe("failed");
  });

  it("does not invent a result from text, disconnects, or context snapshots", () => {
    const messages = [message("u", "user", "run")];
    for (const event of [
      { type: "error", message: "SSE disconnected" },
      { type: "turn_aborted" },
      { type: "context_usage", result: failed },
      { type: "error", code: "SESSION_OCCUPIED", result: failed },
      { type: "error", _preserveActiveRun: true, result: failed },
    ]) expect(applyRunResultToMessages(messages, event)).toBe(messages);
    expect(eventRunResult({ type: "done", result: success, usage: { totalTokens: 8000, segments: [] } })?.usage).toBeUndefined();
    expect(eventRunResult({ type: "done", result: success, usage })?.usage).toEqual(usage);
    expect(eventRunResult({ type: "done", result: { ...success, usage: { ...usage, inputTokens: -1 } } })?.usage).toBeUndefined();
  });

  it("uses transport identity when the result has none", () => {
    expect(eventRunResult({ type: "error", result: { ...failed, runId: undefined }, _nativeRunId: "native" })?.runId).toBe("native");
  });
});

describe("first terminal authority", () => {
  it("keeps same-run errors and clears them only for a distinct succeeding run", () => {
    const error = { type: "error", result: failed, message: "quota" };
    const done = { type: "done", result: { ...success, runId: "r1" } };
    expect(firstRunTerminalEvent(error, done)).toBe(error);
    expect(latestRunTerminalEvent([error, done])).toBe(error);
    const newer = { type: "done", result: success };
    expect(firstRunTerminalEvent(error, newer)).toBe(newer);
    expect(latestRunTerminalEvent([error, newer, done])).toBe(newer);
    expect(latestRunTerminalEvent([{ type: "done", result: success }, { type: "error", result: { ...failed, runId: "r2" } }])?.type).toBe("done");
  });

  it("saves a later reported result without erasing an older result-less failure", () => {
    const messages = [message("u", "user", "run")];
    const first = { type: "error", message: "quota exceeded", runId: "r1" };
    const next = { type: "done", result: { ...success, runId: "r1", usage } };
    const event = authoritativeRunResultEvent(first, next);
    const result = applyRunResultToMessages(messages, event)[0].presentation?.runResult;
    expect(result).toEqual({ ...next.result, status: "failed", reason: "quota_exceeded" });
    expect(authoritativeRunResultEvent({ type: "error", message: "SSE disconnected" }, { type: "done" }).result).toBeUndefined();
  });

  it("handles legacy cleanup conservatively and admission starts a new run", () => {
    const error = { type: "error", message: "quota" };
    expect(latestRunTerminalEvent([error, { type: "done" }])).toBe(error);
    expect(latestRunTerminalEvent([error, { type: "run_admitted" }, { type: "done" }])?.type).toBe("done");
    expect(latestRunTerminalEvent([error, { type: "error", message: "network" }])?.message).toBe("network");
  });
});

describe("safe run result summary", () => {
  it("shows reported input/output without adding cache tokens a second time", () => {
    expect(formatRunResultSummary({ ...success, usage })).toBe("已完成 · 总耗时 3 秒 · 输入 100 / 输出 20 token（部分统计）");
    expect(formatRunResultSummary({ ...success, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } }))
      .toBe("已完成 · 总耗时 3 秒 · 输入 0 / 输出 0 token");
  });

  it("shows unknown token usage, safe reasons, interruption and limit outcomes", () => {
    expect(formatRunResultSummary(failed)).toBe("运行失败：额度不足 · 总耗时 1 秒 · token 未知");
    expect(formatRunResultSummary({ ...failed, status: "cancelled", reason: "user_cancelled" })).toContain("已停止");
    expect(formatRunResultSummary({ ...failed, status: "interrupted", reason: "runtime_interrupted" })).toContain("已中断：运行环境中断");
    expect(formatRunResultSummary({ ...success, reason: "iteration_limit" })).toContain("已结束：已达到执行轮数限制");
    expect(formatRunResultSummary({ ...failed, reason: "RAW_SECRET" as RunResult["reason"] })).not.toContain("RAW_SECRET");
  });
});
