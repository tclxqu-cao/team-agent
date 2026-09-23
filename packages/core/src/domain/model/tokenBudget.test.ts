import { describe, expect, it } from "vitest";
import type { Message } from "./entities.js";
import { estimateRequestTokens } from "./tokenBudget.js";

describe("estimateRequestTokens", () => {
  it("excludes history and presentation metadata from the model request estimate", () => {
    const message: Message = {
      role: "assistant",
      content: "final answer",
      toolCalls: [{ id: "call-1", name: "write_file", arguments: { path: "/tmp/a" } }],
    };
    const withDisplayMetadata: Message = {
      ...message,
      historyId: "history-1",
      presentation: {
        rawContent: "raw".repeat(10_000),
        reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "thinking".repeat(30_000) }],
        completionDurationMs: 120_000,
      },
      toolResultRef: {
        turnId: "turn-1",
        itemId: "item-1",
        revision: "revision-1",
        byteSize: 100_000,
      },
    };

    expect(estimateRequestTokens([withDisplayMetadata])).toBe(estimateRequestTokens([message]));
  });

  it("continues to count model-facing content, tool calls, tool results, and images", () => {
    const baseline = estimateRequestTokens([{ role: "user", content: "short" }]);
    const content = estimateRequestTokens([{ role: "user", content: "中文正文".repeat(1_000) }]);
    const toolCall = estimateRequestTokens([{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "write_file", arguments: { content: "data".repeat(1_000) } }],
    }]);
    const toolResult = estimateRequestTokens([{
      role: "tool",
      content: "result".repeat(1_000),
      name: "write_file",
      toolCallId: "call-1",
      isError: true,
    }]);
    const image = estimateRequestTokens([{
      role: "user",
      content: "inspect",
      images: ["data:image/png;base64,YWJj"],
    }]);

    expect(content).toBeGreaterThan(baseline);
    expect(toolCall).toBeGreaterThan(baseline);
    expect(toolResult).toBeGreaterThan(baseline);
    expect(image).toBeGreaterThanOrEqual(baseline + 1_000);
  });
});
