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
    && presentationKeys.every((key) => key === "executionTrace");
}

function isToolOnlyAssistant(message: ChatMessage): boolean {
  return isAssistantWithToolCalls(message) && message.content.trim().length === 0;
}

export function coalesceAdjacentToolCallMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const previous = result[result.length - 1];
    if (previous && isAssistantWithToolCalls(previous) && isToolOnlyAssistant(message)) {
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
