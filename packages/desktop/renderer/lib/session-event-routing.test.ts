import { describe, expect, it } from "vitest";
import { NATIVE_AGENT_TYPES, type AgentType } from "../../../core/src/domain/agent/agent-type";
import { createAgentStore, type StreamEvent } from "../stores/agentStore";
import {
  mergeProgressiveSessionHistoryPage,
  restoreCodexExecutionTrace,
  restoreSessionHistoryPage,
  type SessionHistoryDetail,
} from "./session-history";
import { mergeCodexExecutionMessages, reconcileCodexExecutionSegments } from "./codex-execution-trace";
import { resolveSessionAgentType, resolveSessionEventTarget } from "./session-event-routing";

describe("resolveSessionEventTarget", () => {
  it("preserves explicit event ownership", () => {
    expect(resolveSessionEventTarget("ca-session")).toBe("ca-session");
    expect(resolveSessionEventTarget("runtime:codex:abc")).toBe("runtime:codex:abc");
  });

  it("rejects events without explicit session ownership", () => {
    expect(resolveSessionEventTarget(undefined)).toBeNull();
    expect(resolveSessionEventTarget(null)).toBeNull();
    expect(resolveSessionEventTarget("")).toBeNull();
    expect(resolveSessionEventTarget("   ")).toBeNull();
  });
});

describe("resolveSessionAgentType", () => {
  it.each(NATIVE_AGENT_TYPES)("identifies %s before its selected metadata arrives", (agentType) => {
    const sessionId = `runtime:${agentType}:native-session`;
    expect(resolveSessionAgentType(sessionId, sessionId, undefined)).toBe(agentType);
    expect(resolveSessionAgentType(sessionId, sessionId, "customer-agent")).toBe(agentType);
    expect(resolveSessionAgentType(sessionId, "another-session", "codex")).toBe(agentType);
  });

  it("uses selected metadata only for ordinary session IDs", () => {
    expect(resolveSessionAgentType("local-session", "local-session", "customer-agent")).toBe("customer-agent");
    expect(resolveSessionAgentType("local-session", "local-session", undefined)).toBeUndefined();
    expect(resolveSessionAgentType("other-session", "local-session", "customer-agent")).toBeUndefined();
  });

  it.each([
    "runtime:customer-agent:native-session",
    "runtime:unknown:native-session",
    "runtime:codex:",
    "runtime:codex:native:session",
  ])("rejects an invalid native identity %s even when metadata is present", (sessionId) => {
    expect(resolveSessionAgentType(sessionId, sessionId, "codex")).toBeUndefined();
  });

  it("keeps early Codex output in its trace across delayed metadata and history reload", () => {
    const sessionId = "runtime:codex:metadata-gap";
    const turnId = "turn-1";
    const paragraphs = ["Checking sources", "Reading guidance", "Sources counted", "Files collected", "Checks completed"];
    const core: SessionHistoryDetail = {
      id: sessionId,
      messages: [{ historyId: "history-message.v1.0.user", role: "user", content: "Collect project knowledge",
        presentation: { executionTrace: { turnId, segmentIndex: 0 } } }],
      history: { delivery: "core", revision: "revision-1" },
    };
    const initial = restoreSessionHistoryPage(core).filter((message) => message.role === "user");
    const store = createAgentStore({ sessionId, messages: initial, messagesBySession: { [sessionId]: initial } });
    let selectedAgentType: AgentType | undefined;
    const deliver = (event: StreamEvent) => {
      const state = store.getState();
      const agentType = resolveSessionAgentType(sessionId, sessionId, selectedAgentType);
      if (agentType === "codex" && event.turnId && event.type === "text_chunk" && event.messagePhase === "commentary") {
        state.applyCodexExecutionEvent(event.turnId, {
          type: "text_chunk", turnId: event.turnId, itemId: event.itemId,
          text: event.text!, messagePhase: "commentary",
        }, sessionId);
      } else if (agentType === "codex" && event.turnId && event.type === "tool_call" && event.toolCall) {
        state.applyCodexExecutionEvent(event.turnId, { type: "tool_call", turnId: event.turnId, toolCall: event.toolCall }, sessionId);
      } else if (agentType === "codex" && event.turnId && event.type === "tool_result" && event.result && "toolCallId" in event.result) {
        state.applyCodexExecutionEvent(event.turnId, { type: "tool_result", turnId: event.turnId, result: event.result }, sessionId);
      } else if (event.type === "text_chunk" && event.text) {
        state.appendText(event.text, sessionId);
      } else if (event.type === "tool_call" && event.toolCall) {
        state.addMessage({ id: crypto.randomUUID(), role: "assistant", content: "",
          toolCalls: [event.toolCall], timestamp: Date.now() }, sessionId);
      } else if (event.type === "tool_result" && event.result && "toolCallId" in event.result) {
        state.updateToolResult(event.result.toolCallId, event.result.content, event.result.isError, sessionId);
      }
    };
    const emitParagraph = (content: string, index: number) => {
      const split = Math.floor(content.length / 2);
      for (const text of [content.slice(0, split), content.slice(split)]) {
        deliver({ type: "text_chunk", turnId, itemId: `message-${index}`, messagePhase: "commentary", text });
      }
      deliver({ type: "tool_call", turnId, toolCall: { id: `tool-${index}`, name: "read_file", arguments: {} } });
      deliver({ type: "tool_result", turnId, result: { toolCallId: `tool-${index}`, content: "read" } });
    };
    paragraphs.slice(0, 2).forEach(emitParagraph);
    const refreshed = mergeProgressiveSessionHistoryPage(store.getState().messages, restoreSessionHistoryPage(core), "core", core.history);
    store.getState().setMessages(refreshed, sessionId);
    selectedAgentType = "claude-code";
    paragraphs.slice(2).forEach((content, index) => emitParagraph(content, index + 2));
    const history = restoreCodexExecutionTrace({
      id: sessionId,
      messages: paragraphs.map((content, index) => ({
        historyId: `codex-trace:${turnId}:agent:message-${index}`, role: "assistant", content,
        presentation: { agentMessagePhase: "commentary", executionTrace: { turnId, segmentIndex: 0 } },
      })),
      history: { delivery: "trace", revision: "revision-1" },
    });
    const reconciled = reconcileCodexExecutionSegments(store.getState().messages, history);
    store.getState().setMessages(reconciled, sessionId);
    expect(reconciled.filter((message) => message.role === "assistant")).toHaveLength(1);
    const display = () => mergeCodexExecutionMessages(history, store.getState().messages[1].executionTrace?.liveMessages ?? []);
    expect(display().filter((message) => message.content).map((message) => message.content)).toEqual(paragraphs);

    emitParagraph("Latest live update", 5);
    expect(display().filter((message) => message.content).map((message) => message.content))
      .toEqual([...paragraphs, "Latest live update"]);
  });
});
