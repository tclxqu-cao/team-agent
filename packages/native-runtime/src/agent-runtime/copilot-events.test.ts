import { describe, expect, it } from "vitest";
import { ResponsePartKind, SessionStatus, ToolCallStatus, TurnState, MessageKind } from "@microsoft/agent-host-protocol";
import type { ActiveTurn, ChatState, ToolCallState, Turn } from "@microsoft/agent-host-protocol";
import { CopilotEventProjection, copilotHistory } from "./copilot-events.js";

const turn = (): ActiveTurn => ({ id: "native-turn", startedAt: "2026-11-03T00:00:00Z", message: { text: "hello", origin: { kind: MessageKind.User } }, responseParts: [], usage: undefined });
const tool: ToolCallState = { status: ToolCallStatus.Completed, toolCallId: "bash", toolName: "bash", displayName: "Bash", intention: "test", invocationMessage: "run", toolInput: '{"command":"printf OK"}', success: true, pastTenseMessage: "ran", content: [{ type: "text", text: "OK" }] } as ToolCallState;

describe("VS Code Copilot projection", () => {
  it("projects native parts without duplicate text or tools across repeated snapshots", () => {
    const p = new CopilotEventProjection(); const t = turn();
    t.responseParts = [{ kind: ResponsePartKind.Markdown, id: "m", content: "Hello" }];
    expect(p.consume(t)).toEqual([{ type: "text_chunk", text: "Hello", itemId: "m", turnId: t.id }]);
    expect(p.consume(t)).toEqual([]);
    t.responseParts[0] = { kind: ResponsePartKind.Markdown, id: "m", content: "Hello world" };
    t.responseParts.push({ kind: ResponsePartKind.ToolCall, toolCall: tool });
    expect(p.consume(t)).toMatchObject([{ type: "text_chunk", text: " world" }, { type: "tool_call", toolCall: { arguments: { command: "printf OK" } } }, { type: "tool_result", result: { content: "OK", isError: false } }]);
    expect(p.consume(t)).toEqual([]);
  });

  it("preserves turn/part identity and native tool order in history", () => {
    const t = { ...turn(), state: TurnState.Complete };
    t.responseParts = [{ kind: ResponsePartKind.Reasoning, id: "r", content: "Plan" }, { kind: ResponsePartKind.ToolCall, toolCall: tool }, { kind: ResponsePartKind.Markdown, id: "m", content: "Done" }];
    const chat: ChatState = { resource: "ahp-chat:/c", title: "test", modifiedAt: "", status: SessionStatus.Idle, turns: [t] };
    const messages = copilotHistory(chat);
    expect(messages.map(message => message.role)).toEqual(["user", "assistant", "assistant", "tool", "assistant"]);
    expect(messages.at(-1)).toMatchObject({ historyId: "native-turn:m", content: "Done" });
    expect(messages[1]?.presentation?.reasoning?.[0]?.text).toBe("Plan");
    expect(messages[3]).toMatchObject({ toolCallId: "bash", content: "OK" });
  });

  it("keeps cancellation/error terminal states and producer usage/duration", () => {
    const p = new CopilotEventProjection();
    const t = { ...turn(), duration: 850, state: TurnState.Cancelled, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 } } as Turn;
    expect(p.terminal(t)).toMatchObject({ type: "turn_aborted", durationMs: 850, usage: { totalTokens: 14, cacheReadTokens: 3 } });
    t.state = TurnState.Error;
    t.responseParts.push({ kind: ResponsePartKind.Error, error: { errorType: "quota", message: "quota exceeded" } });
    expect(p.terminal(t)).toMatchObject({ type: "error", message: "quota exceeded" });
  });

  it("uses the latest copy of the same native turn and part without collapsing different identities", () => {
    const completed = { ...turn(), state: TurnState.Complete };
    completed.responseParts = [{ kind: ResponsePartKind.Markdown, id: "m", content: "partial" }];
    const active = { ...turn(), responseParts: [
      { kind: ResponsePartKind.Markdown, id: "m", content: "partial" },
      { kind: ResponsePartKind.Markdown, id: "m", content: "same" },
      { kind: ResponsePartKind.Markdown, id: "other", content: "same" },
    ] } as ActiveTurn;
    const chat: ChatState = { resource: "ahp-chat:/c", title: "test", modifiedAt: "", status: SessionStatus.InProgress,
      turns: [completed, completed], activeTurn: active };
    expect(copilotHistory(chat)).toEqual([
      { role: "user", content: "hello", historyId: "native-turn:user" },
      { role: "assistant", content: "same", historyId: "native-turn:m", presentation: { nativeMessageId: "native-turn:m" } },
      { role: "assistant", content: "same", historyId: "native-turn:other", presentation: { nativeMessageId: "native-turn:other" } },
    ]);
  });

  it("restores native steering which has been accepted but not consumed", () => {
    const chat: ChatState = { resource: "ahp-chat:/c", title: "test", modifiedAt: "", status: SessionStatus.InProgress,
      turns: [], activeTurn: turn(), steeringMessage: { id: "pending-1", message: { text: "follow up", origin: { kind: MessageKind.User } } } };
    expect(copilotHistory(chat).at(-1)).toMatchObject({ role: "user", content: "follow up", historyId: "copilot-steering:pending-1", name: "__native_steering_pending" });
  });
});
