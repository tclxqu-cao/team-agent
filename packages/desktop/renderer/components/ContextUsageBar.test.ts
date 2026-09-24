import { describe, expect, it } from "vitest";
import { buildContextUsageView, formatContextUsageSummary } from "./ContextUsageBar";
import type { ContextUsageSnapshot } from "../stores/agentStore";

function createUsage(): ContextUsageSnapshot {
  return {
    requestIndex: 2,
    providerId: "anthropic",
    modelId: "claude-test",
    maxTokens: 100_000,
    totalTokens: 10_000,
    ratio: 0.1,
    estimationMode: "heuristic",
    segments: [
      { category: "systemBase", tokens: 1000 },
      { category: "projectContext", tokens: 2000 },
      { category: "currentUserMessage", tokens: 500 },
      { category: "assistantMessages", tokens: 1000 },
      { category: "nativeToolDefinitions", tokens: 3000 },
      { category: "toolResults", tokens: 1500 },
      { category: "images", tokens: 500 },
      { category: "messageOverhead", tokens: 500 },
    ],
  };
}

describe("buildContextUsageView", () => {
  it("shows a neutral placeholder before the first model request", () => {
    const view = buildContextUsageView(undefined, 100);

    expect(view.hasUsage).toBe(false);
    expect(view.maxTokens).toBe(100_000);
    expect(view.totalTokens).toBe(0);
    expect(view.percent).toBe(0);
    expect(view.details).toEqual([]);
  });

  it("groups every detailed category into readable bar segments", () => {
    const view = buildContextUsageView(createUsage(), 1);

    expect(view.maxTokens).toBe(100_000);
    expect(view.totalTokens).toBe(10_000);
    expect(view.percent).toBe(10);
    expect(view.groups.find((group) => group.key === "system")?.tokens).toBe(3000);
    expect(view.groups.find((group) => group.key === "messages")?.tokens).toBe(1500);
    expect(view.groups.find((group) => group.key === "tools")?.tokens).toBe(4500);
    expect(view.groups.find((group) => group.key === "images")?.tokens).toBe(500);
    expect(view.groups.find((group) => group.key === "overhead")?.tokens).toBe(500);
    expect(view.details).toHaveLength(8);
    expect(view.requestLabel).toContain("anthropic · claude-test · 第 2 次请求");
  });

  it("caps the displayed ratio at one", () => {
    const usage = { ...createUsage(), maxTokens: 1000, totalTokens: 2000, ratio: 1 };
    const view = buildContextUsageView(usage, 100);

    expect(view.ratio).toBe(1);
    expect(view.percent).toBe(100);
    expect(view.percentLabel).toBe("100%");
  });

  it("keeps low usage changes visible for a large context window", () => {
    const usage = { ...createUsage(), maxTokens: 1_000_000, totalTokens: 39_000 };
    const view = buildContextUsageView(usage, 1000);

    expect(view.percent).toBe(4);
    expect(view.percentLabel).toBe("3.9%");
    expect(formatContextUsageSummary(view, true)).toBe("3.9%");
  });
});

describe("formatContextUsageSummary", () => {
  it("keeps the full token ratio outside compact mode", () => {
    const view = buildContextUsageView(createUsage(), 100);

    expect(formatContextUsageSummary(view, false)).toBe("10K / 100K · 10%");
  });

  it("shows only percentage in compact mode", () => {
    const view = buildContextUsageView(createUsage(), 100);

    expect(formatContextUsageSummary(view, true)).toBe("10%");
    expect(formatContextUsageSummary(buildContextUsageView(undefined, 100), true)).toBe("0%");
  });
});
