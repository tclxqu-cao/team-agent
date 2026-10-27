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

  it("does not keep an earlier error after completion, interruption, or a new active run", () => {
    const error = { type: "error", message: "quota exceeded" };
    for (const type of ["done", "turn_aborted"]) {
      expect(latestSessionRunError({ status: "idle", events: [error, { type }] })).toBeNull();
    }
    for (const status of ["running", "active"] as const) {
      expect(latestSessionRunError({ status, events: [error] })).toBeNull();
    }
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
