import { describe, expect, it } from "vitest";
import { formatElapsed, initialTuiState, tuiReducer } from "./state.js";

describe("TUI state", () => {
  it("keeps thinking, tools, streamed text, and completion in order", () => {
    let state = tuiReducer(initialTuiState(), { type: "turn_start", now: 0 });
    state = tuiReducer(state, { type: "agent_event", event: { type: "thinking", message: "Iteration 1..." }, now: 10 });
    state = tuiReducer(state, { type: "agent_event", event: { type: "tool_call", toolCall: { id: "1", name: "bash", arguments: { command: "pwd" } } }, now: 20 });
    state = tuiReducer(state, { type: "agent_event", event: { type: "text_chunk", text: "hello" }, now: 30 });
    state = tuiReducer(state, { type: "agent_event", event: { type: "text_chunk", text: " world" }, now: 40 });
    state = tuiReducer(state, { type: "agent_event", event: { type: "done", finalText: "hello world", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } }, now: 1000 });
    expect(state.transcript.map((entry) => entry.type)).toEqual(["tool", "assistant"]);
    expect(state.transcript.at(-1)).toMatchObject({ text: "hello world" });
    expect(state.progress?.completedAt).toBe(1000);
    expect(state.running).toBe(false);
  });

  it("restores history and formats elapsed time", () => {
    let state = tuiReducer(initialTuiState(), { type: "submit_input", input: "first" });
    state = tuiReducer(state, { type: "history", direction: -1 });
    expect(state.input).toBe("first");
    expect(formatElapsed(65_900)).toBe("1:05");
  });

  it("seeds persisted history and keeps tool payloads for scrollback", () => {
    const seeded = initialTuiState(["old one", "old two"]);
    expect(seeded.history).toEqual(["old one", "old two"]);
    expect(seeded.historyIndex).toBe(2);
    const state = tuiReducer(tuiReducer(seeded, { type: "submit_input", input: "first" }), { type: "history", direction: -1 });
    expect(state.input).toBe("first");

    let withTools = tuiReducer(initialTuiState(), { type: "agent_event", event: { type: "tool_call", toolCall: { id: "1", name: "bash", arguments: { command: "for i in 1 2 3\ndo echo $i\ndone" } } }, now: 0 });
    withTools = tuiReducer(withTools, { type: "agent_event", event: { type: "tool_result", result: { toolCallId: "1", content: "line1\nline2" } }, now: 1 });
    expect(withTools.transcript[0]?.type === "tool" && withTools.transcript[0].full).toContain("do echo $i");
    expect(withTools.transcript[1]?.type === "tool" && withTools.transcript[1].full).toContain("line2");
  });

  it("accumulates token usage across completed turns", () => {
    let state = tuiReducer(initialTuiState(), { type: "turn_start", now: 0 });
    state = tuiReducer(state, { type: "agent_event", event: { type: "done", finalText: "a", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }, now: 10 });
    state = tuiReducer(state, { type: "turn_start", now: 20 });
    state = tuiReducer(state, { type: "agent_event", event: { type: "done", finalText: "b", usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }, now: 30 });
    expect(state.usage).toEqual({ inputTokens: 17, outputTokens: 8, totalTokens: 25, turns: 2 });
  });

  it("replaces the whole transcript when a session is replayed", () => {
    let state = tuiReducer(initialTuiState(), { type: "append", entry: { id: "a", type: "user", text: "live" } });
    state = tuiReducer(state, {
      type: "replace_transcript",
      entries: [
        { id: "r0", type: "user", text: "previous question" },
        { id: "r1", type: "assistant", text: "previous answer" },
      ],
    });
    expect(state.transcript.map((entry) => entry.text)).toEqual(["previous question", "previous answer"]);
    expect(state.progress).toBeNull();
    expect(state.streamEntryId).toBeNull();
  });
});
