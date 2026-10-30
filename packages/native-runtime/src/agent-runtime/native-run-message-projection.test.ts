import { describe, expect, it } from "vitest";
import type { AgentEvent, Message } from "@agent/core";
import { mergeProjectionMessages } from "./native-runtime-broker";

const user = (content = "Question"): Message => ({ role: "user", content });
const answer = (content = "Answer"): Message => ({ role: "assistant", content });
const thought = (itemId: string, text: string): Message => ({
  role: "assistant", content: "", presentation: { reasoning: [{ itemId, sectionIndex: 0, text }] },
});
const reasoning = (itemId: string, delta: string): AgentEvent => ({ type: "reasoning_summary_delta", itemId, sectionIndex: 0, delta });

function project(messages: Message[], events: AgentEvent[], agentType: "qoder" | "zcode" | "workbuddy" | "codex" = "qoder") {
  const run: NonNullable<Parameters<typeof mergeProjectionMessages>[1]> = {
    runId: "run", sessionId: "session", agentType, nativeSessionId: "native", input: "Question",
    permissionMode: "request-approval", controller: "web", status: "terminal", nextSequence: events.length,
    createdAt: 1, terminalAt: 2, goalId: null,
  };
  return mergeProjectionMessages(messages, run, events.map((event, index) => ({ runId: "run", sequence: index + 1, event })));
}

describe("native run transcript reconciliation", () => {
  it("keeps Codex's existing identity-based reasoning reconciliation", () => {
    const native = [user(), thought("codex-item", "Check first"), answer()];
    expect(project(native, [reasoning("codex-item", "Check first"), { type: "text_chunk", text: "Answer" }], "codex")).toEqual(native);
  });

  it.each(["qoder", "zcode", "workbuddy"] as const)("keeps %s reasoning before the completed answer when live and history IDs differ", agent => {
    const native = [user(), thought("native-thought", "Check first"), answer()];
    const merged = project(native, [reasoning("live-thought", "Check first"), { type: "text_chunk", text: "Answer" }, { type: "done", finalText: "Answer" }], agent);
    expect(merged).toEqual(native);
    expect(merged.at(-1)?.content).toBe("Answer");
  });

  it("retains a fuller native thought instead of duplicating its partial live prefix", () => {
    const native = [user(), thought("native", "Inspect files"), answer()];
    expect(project(native, [reasoning("live", "Inspect")])).toEqual(native);
  });

  it("extends partial native reasoning in place while retaining its identity", () => {
    expect(project([user(), thought("native", "Inspect"), answer()], [reasoning("live", "Inspect files")]))
      .toEqual([user(), thought("native", "Inspect files"), answer()]);
  });

  it("reconciles a combined live thought with split native reasoning without changing native order", () => {
    const native = [user(), thought("first", "Inspect"), answer("Checking"), thought("second", "Verify"), answer()];
    expect(project(native, [reasoning("combined", "InspectVerify"), { type: "text_chunk", text: "CheckingAnswer" }])).toEqual(native);
  });

  it("inserts event-only reasoning inside its own turn instead of after a later user input", () => {
    const merged = project([user(), answer(), user("Next question")], [reasoning("live", "Check first"), { type: "text_chunk", text: "Answer" }]);
    expect(merged.map(message => message.content || message.presentation?.reasoning?.[0].text)).toEqual(["Question", "Check first", "Answer", "Next question"]);
  });

  it("does not deduplicate a new thought against the same wording in an older turn", () => {
    const native = [user("Previous"), thought("old", "Check first"), answer("Previous answer"), user(), answer()];
    const merged = project(native, [reasoning("new", "Check first"), { type: "text_chunk", text: "Answer" }]);
    expect(merged.filter(message => message.presentation?.reasoning?.length)).toHaveLength(2);
    expect(merged.at(-1)?.content).toBe("Answer");
  });

  it("keeps separate live thoughts on either side of a persisted tool result", () => {
    const tool = { id: "call", name: "Read", arguments: {} };
    const native: Message[] = [user(), { role: "assistant", content: "", toolCalls: [tool] }, { role: "tool", content: "result", toolCallId: "call" }, answer()];
    const merged = project(native, [reasoning("first", "Inspect"), { type: "tool_call", toolCall: tool }, reasoning("second", "Verify"), { type: "text_chunk", text: "Answer" }]);
    expect(merged.map(message => message.content || message.presentation?.reasoning?.[0].text || message.toolCalls?.[0].id)).toEqual(["Question", "Inspect", "call", "result", "Verify", "Answer"]);
  });

  it("places a not-yet-persisted input before its live reasoning and answer", () => {
    const merged = project([user("Previous"), answer("Previous answer")], [reasoning("live", "Check first"), { type: "text_chunk", text: "Answer" }]);
    expect(merged.map(message => message.content || message.presentation?.reasoning?.[0].text)).toEqual(["Previous", "Previous answer", "Question", "Check first", "Answer"]);
  });
});
