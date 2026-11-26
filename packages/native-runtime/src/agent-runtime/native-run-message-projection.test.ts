import { describe, expect, it } from "vitest";
import type { AgentEvent, Message } from "@agent/core";
import { mergeProjectionMessages } from "./native-runtime-broker";

const user = (content = "Question"): Message => ({ role: "user", content });
const answer = (content = "Answer"): Message => ({ role: "assistant", content });
const thought = (itemId: string, text: string): Message => ({
  role: "assistant", content: "", presentation: { reasoning: [{ itemId, sectionIndex: 0, text }] },
});
const reasoning = (itemId: string, delta: string): AgentEvent => ({ type: "reasoning_summary_delta", itemId, sectionIndex: 0, delta });

function project(
  messages: Message[],
  events: AgentEvent[],
  agentType: "qoder" | "zcode" | "workbuddy" | "codex" | "copilot" = "qoder",
  status: "active" | "terminal" = "terminal",
) {
  const run: NonNullable<Parameters<typeof mergeProjectionMessages>[1]> = {
    runId: "run", sessionId: "session", agentType, nativeSessionId: "native", input: "Question",
    permissionMode: "request-approval", controller: "web", status, nextSequence: events.length,
    createdAt: 1, terminalAt: status === "terminal" ? 2 : null, goalId: null,
  };
  return mergeProjectionMessages(messages, run, events.map((event, index) => ({ runId: "run", sequence: index + 1, event })));
}

describe("native run transcript reconciliation", () => {
  it("keeps Codex's existing identity-based reasoning reconciliation", () => {
    const native = [user(), thought("codex-item", "Check first"), answer()];
    expect(project(native, [reasoning("codex-item", "Check first"), { type: "text_chunk", text: "Answer" }], "codex")).toEqual(native);
  });

  it("does not replay Codex output when completed history includes a compaction notice", () => {
    const turnId = "turn";
    const native: Message[] = [
      user(),
      { ...answer("Checking"), historyId: "codex-trace:turn:agent:progress" },
      answer("上下文已压缩"),
      {
        ...answer("Finished"), historyId: "codex-trace:turn:agent:final",
        presentation: { forkPoint: { turnId }, agentMessagePhase: "final_answer" },
      },
    ];
    const replay: AgentEvent[] = [
      { type: "text_chunk", turnId, itemId: "progress", text: "Checking", messagePhase: "commentary" },
      { type: "text_chunk", turnId, itemId: "progress", text: "...", messagePhase: "commentary" },
      { type: "text_chunk", turnId, itemId: "final", text: "Fin", messagePhase: "final_answer" },
      { type: "text_chunk", turnId, itemId: "final", text: "ished", messagePhase: "final_answer" },
      { type: "done", finalText: "Finished", forkPoint: { turnId } },
    ];
    expect(project(native, replay, "codex")).toEqual(native);
  });

  it.each(["active", "terminal"] as const)("replays a %s Codex run in native order across compaction before a final answer exists", status => {
    const commentary = (id: string, text: string): Message => ({
      ...answer(text), historyId: `codex-trace:turn:agent:${id}`, presentation: { agentMessagePhase: "commentary" },
    });
    const chunk = (itemId: string, text: string): AgentEvent => ({
      type: "text_chunk", turnId: "turn", itemId, text, messagePhase: "commentary",
    });
    const tool = { id: "read", name: "Read", arguments: {} };
    const native: Message[] = [
      user(), commentary("a", "Checking"), { ...answer("Compacted"), name: "__compaction_checkpoint__" },
      thought("r", "Inspect"), { role: "assistant", content: "", toolCalls: [tool] },
      { role: "tool", content: "result", toolCallId: tool.id }, commentary("b", "Checking"), commentary("c", "Fin"),
    ];
    const replay: AgentEvent[] = [chunk("a", "Check"), reasoning("r", "Inspect"), { type: "tool_call", toolCall: tool },
      chunk("b", "Checking"), chunk("c", "Fin"), chunk("c", "ished")];
    const expected = [...native.slice(0, -1), commentary("c", "Finished")];
    const merged = project(native, replay, "codex", status);
    expect(merged).toEqual(expected);
    expect(project(merged, replay, "codex", status)).toEqual(expected);
  });

  it("reconciles an incomplete Codex item in place and preserves a different turn's replay", () => {
    const progress: Message = { ...answer("Check"), historyId: "codex-trace:turn:agent:progress" };
    const chunk: AgentEvent = { type: "text_chunk", turnId: "turn", itemId: "progress", text: "Checking" };
    expect(project([user(), progress], [chunk], "codex").map(message => message.content))
      .toEqual(["Question", "Checking"]);

    const previous: Message = { ...progress, historyId: "codex-trace:previous:agent:progress" };
    const final: Message = { ...answer("Finished"), presentation: { forkPoint: { turnId: "turn" } } };
    expect(project([user("Previous"), previous, user(), final], [chunk], "codex").at(-1)?.content)
      .toBe("Checking");
  });

  it("reconciles legacy Codex chunks without IDs across a compaction checkpoint", () => {
    const native = [user(), answer("Starting"), { ...answer("Compacted"), name: "__compaction_checkpoint__" },
      thought("r", "Inspect"), answer("Checked")];
    const replay: AgentEvent[] = [{ type: "text_chunk", text: "Starting" }, reasoning("r", "Inspect"),
      { type: "text_chunk", text: "Checked" }];
    expect(project(native, replay, "codex")).toEqual(native);
  });

  it.each(["qoder", "zcode", "workbuddy", "copilot"] as const)("keeps %s reasoning before the completed answer when live and history IDs differ", agent => {
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
