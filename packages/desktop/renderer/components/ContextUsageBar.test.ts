import { describe, expect, it } from "vitest";
import { estimateContextUsage } from "./ContextUsageBar";
import type { ChatMessage } from "../stores/agentStore";

describe("estimateContextUsage", () => {
  it("shows zero usage for an empty conversation", () => {
    const estimate = estimateContextUsage([], 100);

    expect(estimate.maxTokens).toBe(100_000);
    expect(estimate.totalTokens).toBe(0);
    expect(estimate.ratio).toBe(0);
    expect(estimate.segments.find((s) => s.key === "overhead")?.tokens).toBe(0);
  });

  it("counts user, assistant, and tool segments separately", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "u".repeat(40), timestamp: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "a".repeat(80),
        toolCalls: [{ id: "tc1", name: "read_file", arguments: { path: "file.ts" }, result: "r".repeat(120) }],
        timestamp: 2,
      },
    ];

    const estimate = estimateContextUsage(messages, 1);

    expect(estimate.segments.find((s) => s.key === "user")?.tokens).toBe(10);
    expect(estimate.segments.find((s) => s.key === "assistant")?.tokens).toBe(20);
    expect(estimate.segments.find((s) => s.key === "tools")?.tokens).toBeGreaterThan(30);
    expect(estimate.ratio).toBeLessThanOrEqual(1);
  });

  it("caps ratio at one", () => {
    const messages: ChatMessage[] = [
      { id: "u1", role: "user", content: "x".repeat(100_000), timestamp: 1 },
    ];

    expect(estimateContextUsage(messages, 1).ratio).toBe(1);
  });
});
