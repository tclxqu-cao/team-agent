import type { AgentEvent } from "../agent/entities.js";
import type { Message } from "../model/entities.js";
import type {
  SessionHistoryPage,
  SessionHistoryQuery,
} from "./entities.js";

export const DEFAULT_SESSION_HISTORY_PAGE_SIZE = 50;
export const MAX_SESSION_HISTORY_PAGE_SIZE = 100;

const CURSOR_PREFIX = "history.v1.";

/**
 * Pages history by visible timeline item rather than raw message row. Tool
 * results stay beside their assistant tool call and do not consume a page slot.
 */
export function paginateSessionHistory(
  messages: Message[],
  events: AgentEvent[],
  query: SessionHistoryQuery = {},
): SessionHistoryPage {
  const pageSize = normalizePageSize(query.limit);
  const visibleMessages = messages.filter(
    (message) => message.role === "user" || message.role === "assistant",
  );
  const toolResults = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      toolResults.set(message.toolCallId, message);
    }
  }

  const end = decodeCursor(query.before, visibleMessages.length);
  const nominalStart = Math.max(0, end - pageSize);
  const start = findTurnBoundaryStart(visibleMessages, nominalStart);
  const selected = visibleMessages.slice(start, end);
  const pageMessages: Message[] = [];
  const selectedToolCallIds = new Set<string>();
  for (const message of selected) {
    pageMessages.push(message);
    for (const toolCall of message.toolCalls ?? []) {
      selectedToolCallIds.add(toolCall.id);
      const result = toolResults.get(toolCall.id);
      if (result) pageMessages.push(result);
    }
  }

  return {
    messages: pageMessages,
    events: selectPageEvents(events, selectedToolCallIds),
    history: {
      nextCursor: start > 0 ? `${CURSOR_PREFIX}${start}` : null,
      hasMore: start > 0,
      pageSize: selected.length,
      totalItems: visibleMessages.length,
    },
  };
}

function findTurnBoundaryStart(messages: Message[], nominalStart: number): number {
  if (nominalStart <= 0 || messages[nominalStart]?.role === "user") {
    return nominalStart;
  }
  for (let index = nominalStart - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user") return index;
  }
  return 0;
}

function normalizePageSize(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_SESSION_HISTORY_PAGE_SIZE;
  return Math.max(1, Math.min(MAX_SESSION_HISTORY_PAGE_SIZE, Math.floor(limit!)));
}

function decodeCursor(cursor: string | undefined, fallback: number): number {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return fallback;
  const value = Number(cursor.slice(CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, fallback);
}

function selectPageEvents(events: AgentEvent[], toolCallIds: Set<string>): AgentEvent[] {
  const selected: AgentEvent[] = [];
  let latestContextUsage: AgentEvent | undefined;
  for (const event of events) {
    if (event.type === "context_usage") latestContextUsage = event;
    if (
      event.type === "tool_result"
      && toolCallIds.has(event.result.toolCallId)
    ) {
      selected.push(event);
    }
    if (
      event.type === "native_subagent_update"
      && toolCallIds.has(event.activity.parentToolCallId)
    ) {
      const existingIndex = selected.findIndex((candidate) => (
        candidate.type === "native_subagent_update"
        && candidate.activity.parentToolCallId === event.activity.parentToolCallId
      ));
      if (existingIndex >= 0) selected[existingIndex] = event;
      else selected.push(event);
    }
  }
  if (latestContextUsage) selected.unshift(latestContextUsage);
  return selected;
}
