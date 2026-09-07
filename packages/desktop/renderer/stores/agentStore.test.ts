import { beforeEach, describe, expect, it } from "vitest";
import {
  findLatestContextUsage,
  reduceNativeSubagentActivities,
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
      runtimeProgressBySession: {},
      nativeSubagentsBySession: {},
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

  it("updates a background session cache without replacing the visible messages", () => {
    const visible = [{
      id: "visible-message",
      role: "assistant" as const,
      content: "keep me visible",
      timestamp: 1,
    }];
    const background = [{
      id: "background-message",
      role: "assistant" as const,
      content: "completed in background",
      timestamp: 2,
    }];
    const store = useAgentStore.getState();
    store.setSessionId("visible");
    store.setMessages(visible, "visible");
    useAgentStore.setState({ currentText: "visible stream" });

    useAgentStore.getState().setMessages(background, "background");

    expect(useAgentStore.getState().messages).toEqual(visible);
    expect(useAgentStore.getState().currentText).toBe("visible stream");
    expect(useAgentStore.getState().getMessagesForSession("background")).toEqual(background);
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

  it("replaces session-scoped runtime progress and clears only the target session", () => {
    const store = useAgentStore.getState();
    store.applyRuntimeProgress({ progressId: "thinking", phase: "thinking", label: "Starting" }, "session-a");
    store.applyRuntimeProgress({ progressId: "thinking", phase: "thinking", label: "Reasoning" }, "session-a");
    store.applyRuntimeProgress({ progressId: "tool", phase: "tool", label: "Running" }, "session-b");

    expect(useAgentStore.getState().runtimeProgressBySession["session-a"]).toEqual([
      { progressId: "thinking", phase: "thinking", label: "Reasoning" },
    ]);
    store.clearRuntimeProgress("session-a");
    expect(useAgentStore.getState().runtimeProgressBySession["session-a"]).toBeUndefined();
    expect(useAgentStore.getState().runtimeProgressBySession["session-b"]).toHaveLength(1);
  });

  it("merges reasoning deltas into one stable assistant message", () => {
    const store = useAgentStore.getState();
    store.setSessionId("session-a");
    store.applyReasoningSummary({
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 0,
      delta: "Inspect ",
    }, "session-a");
    store.applyReasoningSummary({
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 0,
      delta: "files",
    }, "session-a");

    expect(useAgentStore.getState().messages).toHaveLength(1);
    expect(useAgentStore.getState().messages[0].presentation?.reasoning).toEqual([
      { itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" },
    ]);
  });

  it("keeps Codex live tools inside one turn-scoped execution trace", () => {
    const store = useAgentStore.getState();
    store.setSessionId("runtime:codex:test");
    store.addMessage({ id: "user-1", role: "user", content: "run", timestamp: 1 }, "runtime:codex:test");
    store.applyCodexExecutionEvent("turn-1", {
      type: "tool_call",
      turnId: "turn-1",
      toolCall: { id: "call-1", name: "shell", arguments: { command: "pwd" } },
    }, "runtime:codex:test");
    store.applyCodexExecutionEvent("turn-1", {
      type: "tool_result",
      turnId: "turn-1",
      result: { toolCallId: "call-1", content: "/repo" },
    }, "runtime:codex:test");

    expect(useAgentStore.getState().messages).toHaveLength(2);
    expect(useAgentStore.getState().messages[1]).toMatchObject({
      executionTrace: {
        turnId: "turn-1",
        liveMessages: [expect.objectContaining({
          toolCalls: [expect.objectContaining({ id: "call-1", result: "/repo" })],
        })],
      },
    });
  });

  it("replaces native subagent activity by session and parent tool call", () => {
    const store = useAgentStore.getState();
    const running = {
      taskId: "task-1",
      parentToolCallId: "agent-tool",
      description: "Inspect",
      status: "running" as const,
      messages: [],
    };
    store.applyNativeSubagentActivity(running, "session-a");
    store.applyNativeSubagentActivity({
      ...running,
      status: "completed",
      summary: "Done",
      messages: [{ role: "assistant", content: "Done" }],
    }, "session-a");
    store.applyNativeSubagentActivity({
      ...running,
      taskId: "task-2",
      parentToolCallId: "agent-other",
    }, "session-b");

    expect(useAgentStore.getState().nativeSubagentsBySession["session-a"]["agent-tool"])
      .toMatchObject({ status: "completed", summary: "Done" });
    expect(useAgentStore.getState().nativeSubagentsBySession["session-b"]["agent-other"]?.taskId)
      .toBe("task-2");
  });

  it("reduces replayed native activity to the latest replacement", () => {
    const base = {
      taskId: "task-1",
      parentToolCallId: "agent-tool",
      description: "Inspect",
      status: "running" as const,
      messages: [],
    };
    expect(reduceNativeSubagentActivities([
      { type: "native_subagent_update", activity: base },
      { type: "text_chunk" },
      { type: "native_subagent_update", activity: { ...base, status: "completed", summary: "Done" } },
    ])).toEqual([{ ...base, status: "completed", summary: "Done" }]);
  });
});
