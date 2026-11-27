import {
  decodeSessionHistoryAnchor,
  sessionHistoryMessageId,
  StaleSessionAnchorError,
  type AgentEvent,
  type Message,
  type SessionHistoryQuery,
  type SessionHistoryView,
  type SessionHistoryWindow,
} from "@agent/core";

// Native history cursors share the `history.v1.` format with the core
// paginator (and with codex-runtime-adapter) so the renderer treats every
// runtime's cursors identically; the ordinal space is each adapter's skeleton.
const NATIVE_HISTORY_CURSOR_PREFIX = "history.v1.";
const NATIVE_HISTORY_MAX_PAGE_SIZE = 100;

export function normalizeNativePageSize(limit?: number): number {
  if (!Number.isFinite(limit)) return 50;
  return Math.max(1, Math.min(NATIVE_HISTORY_MAX_PAGE_SIZE, Math.floor(limit!)));
}

export function nativeHistoryCursor(ordinal: number): string {
  return `${NATIVE_HISTORY_CURSOR_PREFIX}${ordinal}`;
}

export function decodeNativeHistoryCursor(cursor: string | undefined, fallback: number): number {
  if (!cursor?.startsWith(NATIVE_HISTORY_CURSOR_PREFIX)) return fallback;
  const value = Number(cursor.slice(NATIVE_HISTORY_CURSOR_PREFIX.length));
  if (!Number.isSafeInteger(value) || value < 0) return fallback;
  return Math.min(value, fallback);
}

/** Indices of the messages that consume an ordinal (user/assistant only). */
export function nativeHistorySkeleton(messages: readonly Message[]): number[] {
  const skeleton: number[] = [];
  for (const [index, message] of messages.entries()) {
    if (message.role === "user" || message.role === "assistant") skeleton.push(index);
  }
  return skeleton;
}

/**
 * Shared window selection over an adapter's skeleton — same turn-boundary and
 * cursor semantics as codex's selectNativeRange, so latest/before/after/anchor
 * behave identically across native runtimes.
 */
export function selectNativeHistoryRange(
  skeletonMessages: readonly Message[],
  query: SessionHistoryQuery,
  revision: string,
): { start: number; end: number; kind: "latest" | "anchored" } {
  const total = skeletonMessages.length;
  const pageSize = normalizeNativePageSize(query.limit);
  const boundaryEnd = (start: number, size: number): number => {
    let end = Math.min(total, start + size);
    while (end < total && skeletonMessages[end]?.role !== "user") end += 1;
    return end;
  };
  const boundaryStart = (nominal: number): number => {
    if (nominal <= 0 || skeletonMessages[nominal]?.role === "user") return Math.max(0, nominal);
    for (let index = nominal - 1; index >= 0; index -= 1) {
      if (skeletonMessages[index].role === "user") return index;
    }
    return 0;
  };
  if (query.anchor) {
    const target = decodeSessionHistoryAnchor(query.anchor, revision);
    if (target >= total || skeletonMessages[target]?.role !== "user") {
      throw new StaleSessionAnchorError();
    }
    const nominalStart = Math.max(0, target - Math.floor(pageSize / 2));
    const start = boundaryStart(nominalStart);
    const requiredPageSize = Math.max(pageSize, target - start + 1);
    return { start, end: boundaryEnd(start, requiredPageSize), kind: "anchored" };
  }
  if (query.after) {
    const start = decodeNativeHistoryCursor(query.after, total);
    return { start, end: boundaryEnd(start, pageSize), kind: "anchored" };
  }
  const end = decodeNativeHistoryCursor(query.before, total);
  const nominalStart = Math.max(0, end - pageSize);
  return { start: boundaryStart(nominalStart), end, kind: "latest" };
}

/**
 * Materializes one window: visible messages carry historyIds bound to the
 * skeleton ordinals, their tool results ride along, and page events are
 * filtered to the window's tool calls (same rules as the core paginator).
 */
export function buildNativeHistoryPage(
  messages: readonly Message[],
  skeleton: readonly number[],
  start: number,
  end: number,
  events: readonly AgentEvent[],
): { messages: Message[]; events: AgentEvent[] } {
  const toolResults = new Map<string, Message>();
  for (const message of messages) {
    if (message.role === "tool" && message.toolCallId) {
      toolResults.set(message.toolCallId, message);
    }
  }
  const pageMessages: Message[] = [];
  const selectedToolCallIds = new Set<string>();
  for (let pointer = start; pointer < end; pointer += 1) {
    const messageIndex = skeleton[pointer];
    const message = messageIndex === undefined ? undefined : messages[messageIndex];
    if (!message) continue;
    pageMessages.push({ ...message, historyId: sessionHistoryMessageId(messageIndex, message) });
    for (const toolCall of message.toolCalls ?? []) {
      selectedToolCallIds.add(toolCall.id);
      const result = toolResults.get(toolCall.id);
      if (result) pageMessages.push({ ...result });
    }
  }
  const selected: AgentEvent[] = [];
  for (const event of events) {
    if (event.type === "tool_result" && selectedToolCallIds.has(event.result.toolCallId)) {
      selected.push(event);
    }
    if (event.type === "native_subagent_update"
      && selectedToolCallIds.has(event.activity.parentToolCallId)) {
      const existingIndex = selected.findIndex((candidate) => (
        candidate.type === "native_subagent_update"
        && candidate.activity.parentToolCallId === event.activity.parentToolCallId
      ));
      if (existingIndex >= 0) selected[existingIndex] = event;
      else selected.push(event);
    }
  }
  return { messages: pageMessages, events: selected };
}

export function nativeHistoryWindow(
  start: number,
  end: number,
  totalItems: number,
  kind: "latest" | "anchored",
  revision: string,
  delivery?: SessionHistoryView | "legacy-full",
): SessionHistoryWindow {
  return {
    nextCursor: start > 0 ? nativeHistoryCursor(start) : null,
    hasMore: start > 0,
    pageSize: Math.max(0, end - start),
    totalItems,
    olderCursor: start > 0 ? nativeHistoryCursor(start) : null,
    newerCursor: end < totalItems ? nativeHistoryCursor(end) : null,
    kind,
    revision,
    ...(delivery ? { delivery } : {}),
  };
}
