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

  it("treats commentary text as one execution item", () => {
    const commentary = message({
      id: "commentary-1",
      role: "assistant",
      content: "正在检查文件",
      presentation: { agentMessagePhase: "commentary" },
    });

    expect(isCodexExecutionCarrier(commentary)).toBe(true);
    expect(codexExecutionItemCount([commentary])).toBe(1);
  });

  it("merges streamed commentary chunks by stable native item ID", () => {
    const initial = [message({ id: "user-1", role: "user", content: "run" })];
    const first = applyCodexLiveExecutionEvent(initial, "turn-1", {
      type: "text_chunk",
      text: "正在检查",
      turnId: "turn-1",
      itemId: "commentary-1",
      messagePhase: "commentary",
    }, 2);
    const second = applyCodexLiveExecutionEvent(first, "turn-1", {
      type: "text_chunk",
      text: "文件",
      turnId: "turn-1",
      itemId: "commentary-1",
      messagePhase: "commentary",
    }, 3);

    expect(second[1].executionTrace?.liveMessages).toEqual([expect.objectContaining({
      id: "codex-trace:turn-1:agent:commentary-1",
      content: "正在检查文件",
      presentation: { agentMessagePhase: "commentary" },
    })]);
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

  it("keeps live commentary before a later tool when the first snapshot only contains the tool", () => {
    const history = [message({
      id: "history-tool",
      role: "assistant",
      toolCalls: [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        resultRef: { turnId: "turn-1", itemId: "call-1", revision: "rev-1", byteSize: 4 },
      }],
    })];
    const live = [message({
      id: "codex-trace:turn-1:agent:commentary-1",
      role: "assistant",
      content: "先检查目录",
      presentation: { agentMessagePhase: "commentary" },
    }), message({
      id: "live-tool",
      role: "assistant",
      toolCalls: [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        result: "/repo",
      }],
    })];

    const merged = mergeCodexExecutionMessages(history, live);

    expect(merged.map((entry) => entry.id)).toEqual([
      "codex-trace:turn-1:agent:commentary-1",
      "history-tool",
    ]);
    expect(merged.flatMap((entry) => entry.toolCalls ?? [])).toEqual([
      expect.objectContaining({ id: "call-1", result: "/repo" }),
    ]);
  });

  it("satisfies persisted and live ordering constraints around shared native items", () => {
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
      id: "live-commentary",
      role: "assistant",
      content: "开始执行",
      presentation: { agentMessagePhase: "commentary" },
    }), message({
      id: "live-tool",
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
    })];

    const merged = mergeCodexExecutionMessages(history, live);

    expect(merged.map((entry) => entry.id)).toEqual([
      "history-reasoning",
      "live-commentary",
      "history-tool",
    ]);
  });

  it("collapses a duplicate tool inside one snapshot while preserving the first position", () => {
    const history = [message({
      id: "history-tool-call",
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
    }), message({
      id: "history-commentary",
      role: "assistant",
      content: "等待结果",
      presentation: { agentMessagePhase: "commentary" },
    }), message({
      id: "history-tool-result",
      role: "assistant",
      toolCalls: [{
        id: "call-1",
        name: "shell",
        arguments: { command: "pwd" },
        result: "/repo",
      }],
    })];

    const merged = mergeCodexExecutionMessages(history, []);

    expect(merged.map((entry) => entry.id)).toEqual([
      "history-tool-call",
      "history-commentary",
    ]);
    expect(merged[0].toolCalls).toEqual([
      expect.objectContaining({ id: "call-1", result: "/repo" }),
    ]);
  });

  it("collapses duplicate execution identities inside one carrier", () => {
    const history = [message({
      id: "combined-carrier",
      role: "assistant",
      presentation: { reasoning: [
        { itemId: "reasoning-1", sectionIndex: 0, text: "Inspect" },
        { itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" },
      ] },
      toolCalls: [
        { id: "call-1", name: "shell", arguments: { command: "pwd" } },
        { id: "call-1", name: "shell", arguments: { command: "pwd" }, result: "/repo" },
      ],
    })];

    const merged = mergeCodexExecutionMessages(history, []);

    expect(merged).toHaveLength(1);
    expect(merged[0].presentation?.reasoning).toEqual([
      expect.objectContaining({ itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" }),
    ]);
    expect(merged[0].toolCalls).toEqual([
      expect.objectContaining({ id: "call-1", result: "/repo" }),
    ]);
  });

  it("preserves identical commands when their native tool IDs differ", () => {
    const history = [message({
      id: "tool-1",
      role: "assistant",
      toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" } }],
    }), message({
      id: "tool-2",
      role: "assistant",
      toolCalls: [{ id: "call-2", name: "shell", arguments: { command: "pwd" } }],
    })];

    expect(mergeCodexExecutionMessages(history, []).flatMap((entry) => entry.toolCalls ?? []))
      .toHaveLength(2);
  });

  it("coalesces live commentary with a loaded snapshot by stable message ID", () => {
    const id = "codex-trace:turn-1:agent:commentary-1";
    const history = [message({
      id,
      role: "assistant",
      content: "正在检查",
      presentation: { agentMessagePhase: "commentary" },
    })];
    const live = [message({
      id,
      role: "assistant",
      content: "正在检查文件",
      presentation: { agentMessagePhase: "commentary" },
    })];

    expect(mergeCodexExecutionMessages(history, live)).toEqual([
      expect.objectContaining({ id, content: "正在检查文件" }),
    ]);
  });

  it("coalesces fallback live commentary with its loaded native item", () => {
    const history = [message({
      id: "codex-trace:turn-1:agent:commentary-1",
      role: "assistant",
      content: "正在检查实际 PID 和健康状态",
      presentation: { agentMessagePhase: "commentary" },
    })];
    const live = [message({
      id: "codex-live-commentary:turn-1",
      role: "assistant",
      content: "正在检查实际 PID 和健康状态；如果仍是旧进程，会立即重启",
      presentation: { agentMessagePhase: "commentary" },
    })];

    expect(mergeCodexExecutionMessages(history, live)).toEqual([
      expect.objectContaining({
        id: "codex-trace:turn-1:agent:commentary-1",
        content: "正在检查实际 PID 和健康状态；如果仍是旧进程，会立即重启",
      }),
    ]);
  });

  it("keeps independent commentary with native item IDs even when text overlaps", () => {
    const history = [message({
      id: "codex-trace:turn-1:agent:commentary-1",
      role: "assistant",
      content: "正在检查",
      presentation: { agentMessagePhase: "commentary" },
    })];
    const live = [message({
      id: "codex-trace:turn-1:agent:commentary-2",
      role: "assistant",
      content: "正在检查下一项",
      presentation: { agentMessagePhase: "commentary" },
    })];

    expect(mergeCodexExecutionMessages(history, live)).toHaveLength(2);
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
