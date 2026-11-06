import { describe, expect, it, vi } from "vitest";
import { latestSessionRunError, openRunErrorModelPicker, runErrorRecoveryKind } from "./session-run-error";

describe("restored session run failures", () => {
  it("restores an idle native failure and prefers the newer broker submission failure", () => {
    expect(latestSessionRunError({ agentType: "opencode", status: "idle", events: [
      { type: "error", message: "WorkBuddy AI: usage exceeds frequency limit (429)" },
    ] })).toBe("WorkBuddy AI: usage exceeds frequency limit (429)");
    expect(latestSessionRunError({ agentType: "opencode", status: "idle", events: [
      { type: "error", message: "WorkBuddy AI: usage exceeds frequency limit (429)" },
      { type: "error", code: "NATIVE_PROTOCOL_ERROR", message: "fetch failed" },
    ] })).toBe("fetch failed");
  });

  it("keeps the first failure for the same run even after done or abort cleanup", () => {
    const error = { type: "error", runId: "failed-run", message: "quota exceeded" };
    for (const type of ["done", "turn_aborted"]) {
      expect(latestSessionRunError({ status: "idle", events: [error, { type, runId: "failed-run" }] })).toBe("quota exceeded");
      expect(latestSessionRunError({ status: "idle", events: [error, { type, runId: "new-run" }] })).toBeNull();
    }
    expect(latestSessionRunError({ status: "idle", events: [
      { type: "error", message: "quota exceeded" }, { type: "done" },
    ] })).toBe("quota exceeded");
    for (const status of ["running", "active"] as const) {
      expect(latestSessionRunError({ status, events: [error] })).toBeNull();
    }
  });

  it("restores safe results from projected messages even when core history omits events", () => {
    expect(latestSessionRunError({ status: "idle", messages: [{ role: "user", content: "run", presentation: {
      runResult: { status: "failed", reason: "quota_exceeded", durationMs: 1_000, runId: "r1" },
    } }] })).toBe("运行失败：额度不足");
    expect(latestSessionRunError({ status: "idle", events: [{ type: "done", result: {
      status: "failed", reason: "auth_required", durationMs: 1_000, runId: "r1",
    } }] })).toBe("运行失败：需要重新登录或检查凭据");
  });

  it("does not carry an interrupted attempt below a newer retry without a projected result", () => {
    const interrupted = { status: "interrupted" as const, reason: "runtime_interrupted", durationMs: 10, runId: "old" };
    const detail = { status: "idle" as const, messages: [
      { role: "user", content: "按推荐来", presentation: { runResult: interrupted } },
      { role: "user", content: "按推荐来" },
      { role: "assistant", content: "已建好并实测跑通" },
    ] };
    expect(latestSessionRunError(detail)).toBeNull();
    expect(latestSessionRunError({ ...detail, events: [{ type: "error", runId: "old", result: interrupted }] })).toBeNull();
  });

  it("keeps a real failure on the current turn even when there is partial assistant output", () => {
    const failed = { status: "failed" as const, reason: "quota_exceeded", durationMs: 10, runId: "current" };
    expect(latestSessionRunError({ status: "idle", messages: [
      { role: "user", content: "request", presentation: { runResult: failed } },
      { role: "assistant", content: "只有部分输出，尚未完成" },
    ] })).toBe("运行失败：额度不足");
  });

  it("does not misinterpret tool errors, occupied-session recovery, or older trace pages", () => {
    expect(latestSessionRunError({ status: "idle", events: [
      { type: "tool_result", result: { toolCallId: "t", isError: true, content: "bad tool" } },
    ] })).toBeNull();
    for (const code of ["SESSION_OCCUPIED", "SESSION_ALREADY_RUNNING"]) {
      expect(latestSessionRunError({ status: "idle", events: [{ type: "error", code, message: "conflict" }] })).toBeNull();
    }
    for (const history of [{ newerCursor: "history.v1.2" }, { delivery: "trace" as const }]) {
      expect(latestSessionRunError({ status: "idle", history, events: [{ type: "error", message: "old" }] })).toBeNull();
    }
    expect(latestSessionRunError(null)).toBeNull();
  });

  it("shows an explicit fallback instead of silently dropping an empty failure", () => {
    expect(latestSessionRunError({ status: "failed" })).toBe("运行失败，但未记录具体错误");
    expect(latestSessionRunError({ status: "idle", events: [{ type: "error", message: " " }] }))
      .toBe("运行失败，但未记录具体错误");
  });
});

describe("run failure recovery guidance", () => {
  it.each([
    "WorkBuddy AI: usage exceeds frequency limit (429: you can retry your request)",
    "Free usage limit reached. Subscribe to OpenCode Go to keep going",
    "insufficient balance", "quota exceeded", "请求频率过高", "余额不足", "HTTP 402",
  ])("offers model switching for %s", (message) => {
    expect(runErrorRecoveryKind(message)).toBe("model");
  });

  it.each(["fetch failed", "Failed to fetch", "ECONNREFUSED", "连接执行服务失败", "事件流连接超时", "terminated",
    "OpenCode 2 GET /api/session/ses_1/message response read failed: terminated (UND_ERR_SOCKET)"])(
    "keeps connection failure guidance separate for %s", (message) => {
      expect(runErrorRecoveryKind(message)).toBe("connection");
    },
  );

  it("does not label arbitrary tool or UI errors as provider failures", () => {
    expect(runErrorRecoveryKind("Permission denied: write file")).toBe("other");
  });

  it("opens the existing model selector without submitting or changing a model", () => {
    const focus = vi.fn();
    const showPicker = vi.fn();
    openRunErrorModelPicker({ focus, showPicker });
    expect(focus).toHaveBeenCalledOnce();
    expect(showPicker).toHaveBeenCalledOnce();
    expect(() => openRunErrorModelPicker({ focus, showPicker: () => { throw new Error("unsupported"); } })).not.toThrow();
    expect(() => openRunErrorModelPicker({ focus })).not.toThrow();
    expect(() => openRunErrorModelPicker(null)).not.toThrow();
  });
});
