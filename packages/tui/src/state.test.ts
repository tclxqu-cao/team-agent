import { describe, expect, it } from "vitest";
import { formatElapsed, initialTuiState, tuiReducer } from "./state.js";

describe("TUI state", () => {
  it("keeps thinking, tools, streamed text, and completion in order", () => {
    let state = tuiReducer(initialTuiState, { type: "turn_start", now: 0 });
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
    let state = tuiReducer(initialTuiState, { type: "submit_input", input: "first" });
    state = tuiReducer(state, { type: "history", direction: -1 });
    expect(state.input).toBe("first");
    expect(formatElapsed(65_900)).toBe("1:05");
  });
});
