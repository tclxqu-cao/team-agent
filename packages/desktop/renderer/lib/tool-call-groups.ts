import type { ChatMessage } from "../stores/agentStore";
import { toolCallActionKey } from "./tool-call-presentation";

export type ChatToolCall = NonNullable<ChatMessage["toolCalls"]>[number];

export interface ToolCallRenderGroup<T> {
  action: string | null;
  items: T[];
}

function isAssistantWithToolCalls(message: ChatMessage): boolean {
  const presentationKeys = Object.keys(message.presentation ?? {});
  return message.role === "assistant"
    && Boolean(message.toolCalls?.length)
    && !message.isCompactionSummary
    && !message.widget
    && !message.askUser
    && !message.images?.length
    && presentationKeys.every((key) => key === "executionTrace" || key === "reasoning" || key === "agentMessagePhase");
}

function isHiddenReasoning(message: ChatMessage): boolean {
  return message.role === "assistant" && !message.content.trim() && !message.toolCalls?.length
    && !message.isCompactionSummary && !message.widget && !message.askUser
    && !message.images?.length && !message.executionTrace && !message.agentName
    && Boolean(message.presentation?.reasoning?.length)
    && Object.keys(message.presentation ?? {}).every((key) => key === "reasoning" || key === "executionTrace");
}

function sameTraceScope(left: ChatMessage, right: ChatMessage): boolean {
  const a = left.presentation?.executionTrace;
  const b = right.presentation?.executionTrace;
  return (!a && !b) || Boolean(a && b && a.turnId === b.turnId && (a.segmentIndex ?? 0) === (b.segmentIndex ?? 0));
}

function isToolOnlyAssistant(message: ChatMessage): boolean {
  return isAssistantWithToolCalls(message) && message.content.trim().length === 0;
}

export function coalesceAdjacentToolCallMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (isHiddenReasoning(message)) continue;
    const previous = result[result.length - 1];
    if (previous && isAssistantWithToolCalls(previous) && isToolOnlyAssistant(message) && sameTraceScope(previous, message)) {
      result[result.length - 1] = {
        ...previous,
        toolCalls: [...previous.toolCalls!, ...message.toolCalls!],
        timestamp: message.timestamp,
      };
      continue;
    }
    result.push(message);
  }
  return result;
}

export function groupAdjacentToolCallEntries<T extends { toolCall: ChatToolCall }>(entries: readonly T[]): ToolCallRenderGroup<T>[] {
  const groups: ToolCallRenderGroup<T>[] = [];
  for (const entry of entries) {
    const action = toolCallActionKey(entry.toolCall.name);
    const previous = groups[groups.length - 1];
    if (action && previous?.action === action) {
      previous.items.push(entry);
    } else {
      groups.push({ action, items: [entry] });
    }
  }
  return groups;
}
