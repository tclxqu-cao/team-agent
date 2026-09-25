import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import {
  coalesceAdjacentToolCallMessages,
  groupAdjacentToolCallEntries,
  type ChatToolCall,
} from "./tool-call-groups";

function toolCall(id: string, name: string): ChatToolCall {
  return { id, name, arguments: {} };
}

function toolMessage(id: string, call: ChatToolCall): ChatMessage {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: [call],
    timestamp: Number(id.replace(/\D/g, "")) || 0,
  };
}

describe("tool call grouping", () => {
  it("coalesces adjacent tool-only assistant messages", () => {
    const messages = [
      toolMessage("message-1", toolCall("call-1", "shell")),
      toolMessage("message-2", toolCall("call-2", "bash")),
    ];

    const result = coalesceAdjacentToolCallMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("message-1");
    expect(result[0].timestamp).toBe(2);
    expect(result[0].toolCalls?.map((call) => call.id)).toEqual(["call-1", "call-2"]);
  });

  it("coalesces trace-scoped tool carriers", () => {
    const messages = [
      {
        ...toolMessage("message-1", toolCall("call-1", "shell")),
        presentation: { executionTrace: { turnId: "turn-1", segmentIndex: 0 } },
      },
      {
        ...toolMessage("message-2", toolCall("call-2", "bash")),
        presentation: { executionTrace: { turnId: "turn-1", segmentIndex: 0 } },
      },
    ];

    expect(coalesceAdjacentToolCallMessages(messages)[0].toolCalls?.map((call) => call.id))
      .toEqual(["call-1", "call-2"]);
  });

  it("appends pure tool messages to a preceding assistant message that already has content and tools", () => {
    const first: ChatMessage = {
      ...toolMessage("message-1", toolCall("call-1", "shell")),
      content: "先检查当前实现。",
    };
    const messages = [
      first,
      toolMessage("message-2", toolCall("call-2", "bash")),
      toolMessage("message-3", toolCall("call-3", "shell")),
    ];

    const result = coalesceAdjacentToolCallMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("先检查当前实现。");
    expect(result[0].toolCalls?.map((call) => call.id)).toEqual(["call-1", "call-2", "call-3"]);
  });

  it("does not coalesce across visible conversation content", () => {
    const textMessage: ChatMessage = {
      id: "message-text",
      role: "assistant",
      content: "先检查一下。",
      timestamp: 2,
    };
    const userMessage: ChatMessage = {
      id: "message-user",
      role: "user",
      content: "继续",
      timestamp: 4,
    };
    const messages = [
      toolMessage("message-1", toolCall("call-1", "shell")),
      textMessage,
      toolMessage("message-3", toolCall("call-3", "shell")),
      userMessage,
      toolMessage("message-5", toolCall("call-5", "shell")),
    ];

    expect(coalesceAdjacentToolCallMessages(messages)).toEqual(messages);
  });

  it("groups only consecutive calls with the same human-readable action", () => {
    const entries = [
      { toolCall: toolCall("call-1", "shell") },
      { toolCall: toolCall("call-2", "Bash") },
      { toolCall: toolCall("call-3", "Read") },
      { toolCall: toolCall("call-4", "read_file") },
      { toolCall: toolCall("call-5", "shell") },
    ];

    const groups = groupAdjacentToolCallEntries(entries);

    expect(groups.map((group) => ({
      action: group.action,
      ids: group.items.map((entry) => entry.toolCall.id),
    }))).toEqual([
      { action: "运行了命令", ids: ["call-1", "call-2"] },
      { action: "读取了文件", ids: ["call-3", "call-4"] },
      { action: "运行了命令", ids: ["call-5"] },
    ]);
  });

  it("keeps unknown tools as separate rows", () => {
    const entries = [
      { toolCall: toolCall("call-1", "custom_tool") },
      { toolCall: toolCall("call-2", "custom_tool") },
    ];

    const groups = groupAdjacentToolCallEntries(entries);

    expect(groups).toHaveLength(2);
    expect(groups.every((group) => group.action === null && group.items.length === 1)).toBe(true);
  });
});
