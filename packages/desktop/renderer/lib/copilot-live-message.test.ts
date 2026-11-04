import { describe, expect, it } from "vitest";
import { paginateSessionHistory } from "@agent/core";
import type { ChatMessage } from "../stores/agentStore";
import { applyCopilotLiveMessage } from "./copilot-live-message";
import { mergeRefreshedSessionHistory, restoreSessionHistoryPage } from "./session-history";

describe("Copilot live and native history identity", () => {
  it("keeps reasoning, markdown and tools in their own native parts across refreshes", () => {
    let messages: ChatMessage[] = [{ id: "turn:user", role: "user", content: "Earth", timestamp: 1 }];
    messages = applyCopilotLiveMessage(messages, { type: "reasoning_summary_delta", turnId: "turn", itemId: "thought", sectionIndex: 0, delta: "Check" }, 2)!;
    messages = applyCopilotLiveMessage(messages, { type: "text_chunk", turnId: "turn", itemId: "text", text: "Checking assets" }, 3)!;
    messages = applyCopilotLiveMessage(messages, { type: "tool_call", turnId: "turn", toolCall: { id: "cdn", name: "bash", arguments: {} } }, 4)!;
    messages = applyCopilotLiveMessage(messages, { type: "reasoning_summary_delta", turnId: "turn", itemId: "thought", sectionIndex: 0, delta: " assets" }, 5)!;
    expect(messages.map(message => message.id)).toEqual(["turn:user", "turn:thought", "turn:text", "turn:cdn:call"]);
    expect(messages[1].content).toBe("");
    expect(messages[1].presentation?.reasoning?.[0].text).toBe("Check assets");
    const page = paginateSessionHistory(messages.map(message => ({
      ...message, role: message.role as "user" | "assistant", historyId: message.id,
    })), [], { limit: 50 });
    const refreshed = restoreSessionHistoryPage({ agentType: "copilot", ...page });
    messages = mergeRefreshedSessionHistory(messages, refreshed);
    messages = applyCopilotLiveMessage(messages, { type: "tool_call", turnId: "turn", toolCall: { id: "cdn", name: "bash", arguments: { command: "curl" } } }, 6)!;
    expect(messages).toHaveLength(4);
    expect(new Set(messages.map(message => message.id)).size).toBe(4);
    expect(messages[3].toolCalls?.[0].arguments).toEqual({ command: "curl" });
  });

  it("retains repeated text when the native part IDs are different", () => {
    const first = applyCopilotLiveMessage([], { type: "text_chunk", turnId: "turn", itemId: "one", text: "Checking" }, 1)!;
    const messages = applyCopilotLiveMessage(first, { type: "text_chunk", turnId: "turn", itemId: "two", text: "Checking" }, 2)!;
    expect(messages.map(message => message.id)).toEqual(["turn:one", "turn:two"]);
  });

  it("restores pending and consumed steering without losing its display state", () => {
    const messages = restoreSessionHistoryPage({ agentType: "copilot", messages: [
      { role: "user", content: "pending", historyId: "copilot-steering:one", name: "__native_steering_pending" },
      { role: "user", content: "consumed", historyId: "source-two", name: "__native_steered:run" },
    ] });
    expect(messages.map(message => [message.id, message.isSteered])).toEqual([["copilot-steering:one", true], ["source-two", true]]);
  });
});
