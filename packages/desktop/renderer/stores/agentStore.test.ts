import { beforeEach, describe, expect, it } from "vitest";
import {
  findLatestContextUsage,
  useAgentStore,
  type ContextUsageSnapshot,
} from "./agentStore";

function createUsage(requestIndex: number): ContextUsageSnapshot {
  return {
    requestIndex,
    providerId: "mock",
    modelId: "mock-model",
    maxTokens: 100_000,
    totalTokens: requestIndex * 100,
    ratio: requestIndex / 1000,
    estimationMode: "heuristic",
    segments: [{ category: "systemBase", tokens: requestIndex * 100 }],
  };
}

describe("agentStore session message cache", () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      messagesBySession: {},
      contextUsageBySession: {},
      currentText: "",
      runningSessionId: null,
      sessionId: null,
      todos: [],
      cronTasks: [],
    });
  });

  it("keeps background session text out of the visible message list", () => {
    useAgentStore.getState().setSessionId("visible");
    useAgentStore.getState().appendText("background text", "background");

    expect(useAgentStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState().getMessagesForSession("background")).toMatchObject([
      { role: "assistant", content: "background text" },
    ]);
  });

  it("updates visible messages when the event belongs to the current session", () => {
    useAgentStore.getState().setSessionId("visible");
    useAgentStore.getState().appendText("hello", "visible");

    expect(useAgentStore.getState().messages).toMatchObject([
      { role: "assistant", content: "hello" },
    ]);
    expect(useAgentStore.getState().getMessagesForSession("visible")).toMatchObject([
      { role: "assistant", content: "hello" },
    ]);
  });

  it("merges assistant tool calls into the prior assistant text in a background session", () => {
    const store = useAgentStore.getState();
    store.setSessionId("visible");
    store.appendText("I will read a file", "background");
    store.addMessage({
      id: "tool-call-message",
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tc1", name: "read_file", arguments: { path: "a.ts" } }],
      timestamp: 1,
    }, "background");
    store.updateToolResult("tc1", "file content", false, "background");

    const background = useAgentStore.getState().getMessagesForSession("background");
    expect(background).toHaveLength(1);
    expect(background[0]).toMatchObject({ role: "assistant", content: "I will read a file" });
    expect(background[0].toolCalls?.[0]).toMatchObject({ id: "tc1", result: "file content", isError: false });
    expect(useAgentStore.getState().messages).toEqual([]);
  });

  it("keeps the latest context usage isolated by session", () => {
    const store = useAgentStore.getState();
    store.setContextUsage(createUsage(1), "session-a");
    store.setContextUsage(createUsage(2), "session-b");
    store.setContextUsage(createUsage(3), "session-a");

    expect(useAgentStore.getState().getContextUsageForSession("session-a")?.requestIndex).toBe(3);
    expect(useAgentStore.getState().getContextUsageForSession("session-b")?.requestIndex).toBe(2);
  });

  it("clears context usage only for the target session", () => {
    const store = useAgentStore.getState();
    store.setContextUsage(createUsage(1), "session-a");
    store.setContextUsage(createUsage(2), "session-b");
    store.clearMessages("session-a");

    expect(useAgentStore.getState().getContextUsageForSession("session-a")).toBeUndefined();
    expect(useAgentStore.getState().getContextUsageForSession("session-b")?.requestIndex).toBe(2);
  });

  it("restores the latest persisted context usage event", () => {
    expect(findLatestContextUsage([
      { type: "context_usage", usage: createUsage(1) },
      { type: "text_chunk" },
      { type: "context_usage", usage: createUsage(2) },
    ])?.requestIndex).toBe(2);
    expect(findLatestContextUsage([{ type: "text_chunk" }])).toBeUndefined();
  });
});
