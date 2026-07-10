import { beforeEach, describe, expect, it } from "vitest";
import { useAgentStore } from "./agentStore";

describe("agentStore session message cache", () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      messagesBySession: {},
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
});
