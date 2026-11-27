import { describe, expect, it } from "vitest";
import { zcodeModelProgress } from "./zcode-model-progress.js";

describe("ZCode native model progress", () => {
  it("projects the native quota message and chosen backoff, not the longer provider retry-after", () => {
    const message = "ZCode: [1308][已达到 5 小时的使用上限。您的限额将在 2026-10-27 14:07:46 重置。]";
    const progress = zcodeModelProgress({ type: "model_retry_scheduled", attempt: 9, nextAttempt: 10, maxAttempts: 11,
      delayMs: 50_030, retryAfterMs: 7_307_000, statusCode: 429, message });

    expect(progress).toEqual({ type: "runtime_progress", progressId: "zcode:model-request", phase: "retry",
      label: "ZCode 请求重试 10/11", detail: `${message}\n原生运行时将在 51 秒后重试`, status: "running" });
  });

  it("uses one progress identity and replaces old retry detail on request start or completion", () => {
    const retry = zcodeModelProgress({ type: "model_retry_scheduled", nextAttempt: 2, message: "Retrying" });
    const started = zcodeModelProgress({ type: "model_request_started", attempt: 2, maxAttempts: 11 });
    const completed = zcodeModelProgress({ type: "model_request_completed", attempt: 2, maxAttempts: 11 });

    expect(started).toEqual({ type: "runtime_progress", progressId: retry?.progressId, phase: "thinking",
      label: "ZCode 正在请求模型 2/11", status: "running" });
    expect(completed).toEqual({ type: "runtime_progress", progressId: retry?.progressId, phase: "status",
      label: "ZCode 模型请求完成 2/11", status: "completed" });
    expect(started).not.toHaveProperty("detail");
    expect(completed).not.toHaveProperty("detail");
  });

  it("does not copy native headers, raw metadata or provider configuration into Agent events", () => {
    const progress = zcodeModelProgress({ type: "model_retry_scheduled", nextAttempt: 2, maxAttempts: 11,
      message: "Service unavailable", requestHeaders: { Authorization: "private-request-credential" },
      responseHeaders: { "set-cookie": "private-response-cookie" }, _meta: { token: "private-metadata" },
      baseURL: "https://private-host.invalid", providerId: "private-provider", modelId: "private-model" });

    expect(progress).toEqual({ type: "runtime_progress", progressId: "zcode:model-request", phase: "retry",
      label: "ZCode 请求重试 2/11", detail: "Service unavailable", status: "running" });
    expect(JSON.stringify(progress)).not.toContain("private-");
  });

  it.each([undefined, "2", -1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "does not invent attempt numbers from invalid native counters %s", nextAttempt => {
      const progress = zcodeModelProgress({ type: "model_retry_scheduled", nextAttempt, maxAttempts: 11 });
      expect(progress?.label).toBe("ZCode 请求重试");
    },
  );

  it.each([undefined, "11", -1, 0, 2.5, Number.NaN, Number.POSITIVE_INFINITY, 1])(
    "omits an invalid or contradictory maximum %s", maxAttempts => {
      expect(zcodeModelProgress({ type: "model_retry_scheduled", nextAttempt: 2, maxAttempts })?.label).toBe("ZCode 请求重试 2");
    },
  );

  it.each([undefined, "1000", -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "does not display an invalid native backoff %s", delayMs => {
      const progress = zcodeModelProgress({ type: "model_retry_scheduled", delayMs, message: "  " });
      expect(progress).not.toHaveProperty("detail");
    },
  );

  it("retains an explicit immediate native retry without inventing an error reason", () => {
    expect(zcodeModelProgress({ type: "model_retry_scheduled", delayMs: 0 })?.detail).toBe("原生运行时将在 0 秒后重试");
  });

  it.each([{}, { type: {} }, { type: "model_request_failed", retryable: true }, { type: "turn.completed" }, { messageCount: 2 }])(
    "ignores unrelated updates instead of inventing terminal state", payload => {
      expect(zcodeModelProgress(payload)).toBeUndefined();
    },
  );
});
