import { beforeEach, describe, expect, it } from "vitest";
import { messageActionPolicy } from "../lib/message-actions";
import {
  findLatestContextUsage,
  reduceNativeSubagentActivities,
  resolveVisibleSessionMessages,
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

  it("hides the previous session while a newly selected session takes over the store", () => {
    const previous = [{ id: "old", role: "assistant" as const, content: "old history", timestamp: 1 }];
    const next = [{ id: "new", role: "user" as const, content: "new question", timestamp: 2 }];

    expect(resolveVisibleSessionMessages(previous, { new: next }, "old", "new")).toEqual(next);
    expect(resolveVisibleSessionMessages(previous, {}, "old", "empty")).toEqual([]);
    expect(resolveVisibleSessionMessages(previous, { old: previous }, "old", null)).toEqual([]);
    expect(resolveVisibleSessionMessages(previous, { old: previous }, "old", "old")).toBe(previous);
    expect(resolveVisibleSessionMessages(previous, { old: previous }, "old", undefined)).toBe(previous);
  });

  it("keeps background session text out of the visible message list", () => {
    useAgentStore.getState().setSessionId("visible");
    useAgentStore.getState().appendText("background text", "background");

    expect(useAgentStore.getState().messages).toEqual([]);
    expect(useAgentStore.getState().getMessagesForSession("background")).toMatchObject([
      { role: "assistant", content: "background text" },
    ]);
  });

  it("does not copy the previous history when a newly selected session receives text", () => {
    const store = useAgentStore.getState();
    store.setSessionId("old");
    store.addMessage({ id: "old-question", role: "user", content: "push to Gitee", timestamp: 1 });
    store.appendText("old answer", "old");
    const oldMessages = store.getMessagesForSession("old");

    store.setSessionId("new");
    store.appendText("new answer", "new");

    expect(useAgentStore.getState().messages).toMatchObject([
      { role: "assistant", content: "new answer" },
    ]);
    expect(store.getMessagesForSession("new")).toEqual(useAgentStore.getState().messages);
    expect(store.getMessagesForSession("old")).toEqual(oldMessages);
  });

  it("selects cached history atomically and preserves it when selecting the same session", () => {
    const store = useAgentStore.getState();
    store.setSessionId("old");
    store.appendText("old answer");
    store.addMessage({ id: "new-question", role: "user", content: "new question", timestamp: 2 }, "new");
    store.setSessionId("new");
    expect(useAgentStore.getState().currentText).toBe("");
    expect(useAgentStore.getState().messages).toEqual(store.getMessagesForSession("new"));
    store.appendText("streaming");
    store.setSessionId("new");
    expect(useAgentStore.getState().currentText).toBe("streaming");
    store.setSessionId("");
    expect(useAgentStore.getState().messages).toEqual([]);
    expect(store.getMessagesForSession("old")[0].content).toBe("old answer");
  });

  it.each(["visible", "background"])("keeps tool execution and final output outside cards in %s sessions", (sid) => {
    const store = useAgentStore.getState();
    store.setSessionId("visible");
    store.addMessage({
      id: "question", role: "assistant", content: "", timestamp: 1,
      askUser: { questionId: "q1", question: "选择配置", answered: true },
    }, sid);
    store.addMessage({
      id: "command", role: "assistant", content: "", timestamp: 2,
      toolCalls: [{ id: "tc1", name: "bash", arguments: {} }],
    }, sid);
    store.updateToolResult("tc1", "分镜已生成", false, sid);
    store.addMessage({
      id: "workbench", role: "assistant", content: "", timestamp: 3,
      widget: { widgetId: "w1", widgetType: "storyboard_workbench", data: { status: "generating" } },
    }, sid);
    store.appendText("分镜完成，", sid);
    store.appendText("视频尚未生成。", sid);

    const messages = store.getMessagesForSession(sid);
    expect(messages).toHaveLength(4);
    expect(messages[0].toolCalls).toBeUndefined();
    expect(messages[1].toolCalls?.[0].result).toBe("分镜已生成");
    expect(messages[2].content).toBe("");
    expect(messages[3]).toMatchObject({ role: "assistant", content: "分镜完成，视频尚未生成。" });
    expect(messages[3].widget).toBeUndefined();
    expect(messageActionPolicy(messages, 3, true).showCompletion).toBe(false);
    expect(messageActionPolicy(messages, 3, false).showCompletion).toBe(true);
    expect(useAgentStore.getState().messages).toEqual(sid === "visible" ? messages : []);
    store.updateMessage(messages[3].id, (message) => ({
      ...message, presentation: { completionDurationMs: 90000 },
    }), sid);
    expect(store.getMessagesForSession(sid)[3].presentation?.completionDurationMs).toBe(90000);
    if (sid === "visible") {
      expect(useAgentStore.getState().messages[3].presentation?.completionDurationMs).toBe(90000);
    }
  });

  it("keeps commands after a widget in their own visible message", () => {
    const store = useAgentStore.getState();
    store.setSessionId("visible");
    store.addMessage({
      id: "workbench", role: "assistant", content: "", timestamp: 1,
      widget: { widgetId: "w1", widgetType: "storyboard_workbench", data: {} },
    });
    store.addMessage({
      id: "command", role: "assistant", content: "", timestamp: 2,
      toolCalls: [{ id: "tc1", name: "bash", arguments: {} }],
    });
    expect(useAgentStore.getState().messages).toHaveLength(2);
    expect(useAgentStore.getState().messages[0].toolCalls).toBeUndefined();
    expect(useAgentStore.getState().messages[1].widget).toBeUndefined();
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
