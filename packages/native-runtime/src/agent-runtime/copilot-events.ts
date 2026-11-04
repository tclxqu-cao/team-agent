import type { AgentEvent, Message, TokenUsage, ToolCall } from "@agent/core";
import type { ActiveTurn, ChatState, StringOrMarkdown, ToolCallState, Turn, UsageInfo } from "@microsoft/agent-host-protocol";

export function copilotText(value: StringOrMarkdown | undefined): string {
  return typeof value === "string" ? value : value?.markdown ?? "";
}

export function copilotToolCall(tool: ToolCallState): ToolCall {
  const input = "toolInput" in tool ? tool.toolInput : undefined;
  let args: Record<string, unknown> = {};
  if (typeof input === "string") {
    try { const value = JSON.parse(input); args = value && typeof value === "object" && !Array.isArray(value) ? value : { input }; }
    catch { args = { input }; }
  } else if (input) args = { inputResource: input.uri };
  return { id: tool.toolCallId, name: tool.toolName, arguments: args };
}

export function copilotToolOutput(tool: ToolCallState): string {
  if (tool.status === "cancelled") return copilotText(tool.reasonMessage) || "Tool cancelled";
  if (!("content" in tool)) return "";
  return tool.content?.map(content => content.type === "text" ? content.text
    : "uri" in content ? `[${content.type}] ${content.uri}` : `[${content.type}]`).join("\n")
    || ("error" in tool ? tool.error?.message : "") || ("pastTenseMessage" in tool ? copilotText(tool.pastTenseMessage) : "");
}

export function copilotUsage(usage: UsageInfo | undefined): TokenUsage | undefined {
  if (!usage || (usage.inputTokens === undefined && usage.outputTokens === undefined)) return undefined;
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}), source: "runtime" };
}

/** Native turn and part IDs remain stable across streaming and history reloads. */
export function copilotHistory(chat: ChatState): Message[] {
  const messages: Message[] = [];
  const turns = new Map([...chat.turns, ...(chat.activeTurn ? [chat.activeTurn] : [])].map(turn => [turn.id, turn]));
  for (const turn of turns.values()) {
    const images = turn.message.attachments?.flatMap(attachment => attachment.type === "embeddedResource" && attachment.contentType.startsWith("image/")
      ? [`data:${attachment.contentType};base64,${attachment.data}`] : []);
    messages.push({ role: "user", content: turn.message.text, historyId: `${turn.id}:user`, ...(images?.length ? { images } : {}) });
    const parts = new Map(turn.responseParts.map((part, index) => [
      part.kind === "toolCall" ? `tool:${part.toolCall.toolCallId}` : "id" in part ? `${part.kind}:${part.id}` : `${part.kind}:${index}`,
      part,
    ]));
    for (const part of parts.values()) {
      if (part.kind === "markdown") messages.push({ role: "assistant", content: part.content, historyId: `${turn.id}:${part.id}` });
      else if (part.kind === "reasoning") messages.push({ role: "assistant", content: "", historyId: `${turn.id}:${part.id}`,
        presentation: { reasoning: [{ itemId: part.id, sectionIndex: 0, text: part.content }] } });
      else if (part.kind === "toolCall") {
        const tool = part.toolCall;
        messages.push({ role: "assistant", content: "", historyId: `${turn.id}:${tool.toolCallId}:call`, toolCalls: [copilotToolCall(tool)] });
        if (["completed", "cancelled", "pending-result-confirmation"].includes(tool.status)) messages.push({ role: "tool",
          content: copilotToolOutput(tool), historyId: `${turn.id}:${tool.toolCallId}:result`, toolCallId: tool.toolCallId,
          isError: tool.status === "cancelled" || ("success" in tool && !tool.success) });
      } else if (part.kind === "error") messages.push({ role: "assistant", content: part.error.message, historyId: `${turn.id}:error` });
    }
  }
  if (chat.steeringMessage) messages.push({
    role: "user", content: chat.steeringMessage.message.text,
    historyId: `copilot-steering:${chat.steeringMessage.id}`, name: "__native_steering_pending",
  });
  return messages.map(message => message.role === "assistant" ? {
    ...message, presentation: { ...message.presentation, nativeMessageId: message.historyId },
  } : message);
}

/** Project authoritative reducer state so duplicate echoes cannot duplicate output. */
export class CopilotEventProjection {
  private readonly text = new Map<string, string>();
  private readonly reasoning = new Map<string, string>();
  private readonly calls = new Set<string>();
  private readonly results = new Set<string>();

  consume(turn: Turn | ActiveTurn): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const part of turn.responseParts) {
      if (part.kind === "markdown" || part.kind === "reasoning") {
        const seen = part.kind === "markdown" ? this.text : this.reasoning;
        const previous = seen.get(part.id) ?? "";
        const delta = part.content.startsWith(previous) ? part.content.slice(previous.length) : "";
        seen.set(part.id, part.content);
        if (delta) events.push(part.kind === "markdown" ? { type: "text_chunk", text: delta, itemId: part.id, turnId: turn.id }
          : { type: "reasoning_summary_delta", itemId: part.id, sectionIndex: 0, delta, turnId: turn.id });
      } else if (part.kind === "toolCall") {
        const tool = part.toolCall;
        if (tool.status !== "streaming" && !this.calls.has(tool.toolCallId)) {
          this.calls.add(tool.toolCallId);
          events.push({ type: "tool_call", toolCall: copilotToolCall(tool), turnId: turn.id });
        }
        if (["completed", "cancelled"].includes(tool.status) && !this.results.has(tool.toolCallId)) {
          this.results.add(tool.toolCallId);
          events.push({ type: "tool_result", turnId: turn.id, result: { toolCallId: tool.toolCallId,
            content: copilotToolOutput(tool), isError: tool.status === "cancelled" || ("success" in tool && !tool.success) } });
        }
      }
    }
    return events;
  }

  terminal(turn: Turn): AgentEvent {
    const usage = copilotUsage(turn.usage);
    if (turn.state === "cancelled") return { type: "turn_aborted", usage, durationMs: turn.duration };
    if (turn.state === "error") return { type: "error", message: turn.responseParts.find(part => part.kind === "error")?.error.message ?? "VS Code Copilot 执行失败", usage, durationMs: turn.duration };
    return { type: "done", finalText: turn.responseParts.flatMap(part => part.kind === "markdown" ? [part.content] : []).join(""), usage, durationMs: turn.duration };
  }
}
