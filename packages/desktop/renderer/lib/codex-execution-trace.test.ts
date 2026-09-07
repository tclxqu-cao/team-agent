import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import {
  applyCodexLiveExecutionEvent,
  applyCodexExecutionToolResult,
  codexExecutionItemCount,
  groupCodexExecutionTrace,
  isCodexExecutionCarrier,
  mergeCodexExecutionMessages,
} from "./codex-execution-trace";

function message(value: Partial<ChatMessage> & Pick<ChatMessage, "id" | "role">): ChatMessage {
  return { content: "", timestamp: 1, ...value };
}

describe("Codex execution trace projection", () => {
  it("inserts one stable disclosure after a trace-bearing user message", () => {
    const projected = groupCodexExecutionTrace([
      message({
        id: "user-1",
        role: "user",
        content: "run",
        presentation: { executionTrace: { turnId: "turn-1" } },
      }),
      message({ id: "answer-1", role: "assistant", content: "done" }),
    ], "rev-1");

    expect(projected.map((entry) => [entry.id, entry.content])).toEqual([
      ["user-1", "run"],
      ["codex-execution-trace:turn-1", ""],
      ["answer-1", "done"],
    ]);
    expect(projected[1].executionTrace).toEqual({ turnId: "turn-1", revision: "rev-1" });
    expect(groupCodexExecutionTrace(projected, "rev-1")).toEqual(projected);
  });

  it("leaves non-Codex messages unchanged", () => {
    const messages = [message({ id: "user-1", role: "user", content: "plain" })];
    expect(groupCodexExecutionTrace(messages, "rev-1")).toEqual(messages);
  });

  it("counts reasoning sections and tools and applies one lazy result", () => {
    const messages = [message({
      id: "trace-1",
      role: "assistant",
      presentation: {
        reasoning: [
          { itemId: "reasoning-1", sectionIndex: 0, text: "inspect" },
          { itemId: "reasoning-1", sectionIndex: 1, text: "decide" },
        ],
      },
      toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
    })];

    expect(isCodexExecutionCarrier(messages[0])).toBe(true);
    expect(codexExecutionItemCount(messages)).toBe(3);
    expect(applyCodexExecutionToolResult(messages, "call-1", "/repo")[0].toolCalls?.[0])
      .toMatchObject({ result: "/repo" });
  });

  it("projects a live call and result into the owning turn without a top-level tool row", () => {
    const initial = [
      message({ id: "user-1", role: "user", content: "run" }),
      message({ id: "answer-1", role: "assistant", content: "starting" }),
    ];
    const withCall = applyCodexLiveExecutionEvent(initial, "turn-1", {
      type: "tool_call",
      turnId: "turn-1",
      toolCall: { id: "call-1", name: "shell", arguments: { command: "pwd" } },
    }, 2);
    const withResult = applyCodexLiveExecutionEvent(withCall, "turn-1", {
      type: "tool_result",
      turnId: "turn-1",
      result: { toolCallId: "call-1", content: "/repo" },
    }, 3);

    expect(withResult.map((entry) => entry.id)).toEqual([
      "user-1",
      "codex-execution-trace:turn-1",
      "answer-1",
    ]);
    expect(withResult[1].executionTrace).toMatchObject({
      turnId: "turn-1",
      revision: "live:turn-1",
      liveMessages: [expect.objectContaining({
        toolCalls: [expect.objectContaining({ id: "call-1", result: "/repo" })],
      })],
    });
  });

  it("merges repeated live items with a trace snapshot by stable item IDs", () => {
    const history = [message({
      id: "history-reasoning",
      role: "assistant",
      presentation: { reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspect" }] },
    }), message({
      id: "history-tool",
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
    })];
    const live = [message({
      id: "live-reasoning",
      role: "assistant",
      presentation: { reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" }] },
    }), message({
      id: "live-tool",
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" }, result: "/repo" }],
    })];

    const merged = mergeCodexExecutionMessages(history, live);
    expect(codexExecutionItemCount(merged)).toBe(2);
    expect(merged[0].presentation?.reasoning?.[0].text).toBe("Inspect files");
    expect(merged[1].toolCalls?.[0].result).toBe("/repo");
  });

  it("keeps live messages when a core revision replaces the trace locator", () => {
    const liveMessages = [message({
      id: "live-tool",
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "shell", arguments: {} }],
    })];
    const projected = groupCodexExecutionTrace([
      message({
        id: "user-1",
        role: "user",
        presentation: { executionTrace: { turnId: "turn-1" } },
      }),
      message({
        id: "codex-execution-trace:turn-1",
        role: "assistant",
        executionTrace: { turnId: "turn-1", revision: "live:turn-1", liveMessages },
      }),
    ], "rev-2");

    expect(projected[1].executionTrace).toEqual({
      turnId: "turn-1",
      revision: "rev-2",
      liveMessages,
    });
  });
});
