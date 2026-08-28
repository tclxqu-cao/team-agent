import { describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { AgentEventBuffer } from "./stream-buffer.js";

describe("AgentEventBuffer", () => {
  it("coalesces consecutive text chunks on the render interval", () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const buffer = new AgentEventBuffer((event) => events.push(event), 80);

    buffer.push({ type: "text_chunk", text: "one" });
    buffer.push({ type: "text_chunk", text: " two" });
    vi.advanceTimersByTime(79);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual([{ type: "text_chunk", text: "one two" }]);
    vi.useRealTimers();
  });

  it("flushes text before boundary events and preserves order", () => {
    const events: AgentEvent[] = [];
    const buffer = new AgentEventBuffer((event) => events.push(event));

    buffer.push({ type: "text_chunk", text: "answer" });
    buffer.push({ type: "tool_call", toolCall: { id: "call", name: "bash", arguments: { command: "pwd" } } });

    expect(events.map((event) => event.type)).toEqual(["text_chunk", "tool_call"]);
  });

  it("flushes once when disposed", () => {
    vi.useFakeTimers();
    const events: AgentEvent[] = [];
    const buffer = new AgentEventBuffer((event) => events.push(event));

    buffer.push({ type: "text_chunk", text: "final" });
    buffer.dispose();
    vi.runAllTimers();

    expect(events).toEqual([{ type: "text_chunk", text: "final" }]);
    vi.useRealTimers();
  });
});
