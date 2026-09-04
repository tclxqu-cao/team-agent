import type { MessagePresentation } from "@agent/core";
import type { ChatMessage, ContextUsageSnapshot } from "../stores/agentStore";
import type { SessionGoalState } from "../global";

export interface PersistedHistoryEvent {
  type?: string;
  text?: string;
  finalText?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: { toolCallId?: string; content?: string; isError?: boolean };
  usage?: ContextUsageSnapshot;
  questionId?: string;
  question?: string;
  options?: Array<{ label: string; description: string }>;
  fields?: Array<{ name: string; label: string; description?: string; type?: "text" | "secret" }>;
  multiSelect?: boolean;
}

export interface SessionHistoryDetail {
  agentType?: "customer-agent" | "codex" | "claude-code" | "opencode";
  status?: "idle" | "running" | "completed" | "failed";
  occupancy?: "available" | "owned-by-customer-agent" | "owned-externally";
  messages?: Array<{
    role?: string;
    content?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    name?: string;
    presentation?: MessagePresentation;
  }>;
  events?: PersistedHistoryEvent[];
  history?: {
    nextCursor?: string | null;
    hasMore?: boolean;
    pageSize?: number;
    totalItems?: number;
  };
  goalState?: SessionGoalState;
}

export function restoreSessionHistoryPage(detail: SessionHistoryDetail | null): ChatMessage[] {
  const persisted = detail?.messages ?? [];
  const events = detail?.events ?? [];
  const resolvedQuestionIds = new Set(
    events
      .filter((event) => event.type === "approval_resolved" && event.questionId)
      .map((event) => event.questionId!),
  );
  const eventToolResults = new Map<string, { content: string; isError?: boolean }>();
  for (const event of events) {
    if (event.type === "tool_result" && event.result?.toolCallId) {
      eventToolResults.set(event.result.toolCallId, {
        content: event.result.content ?? "",
        isError: event.result.isError,
      });
    }
  }

  const rawMessages = persisted
    .filter((message) => (
      message.role === "user"
      || message.role === "assistant"
      || message.role === "tool"
    ) && message.name !== "__interrupt__")
    .map(toChatMessage);
  const messageToolResults = new Map<string, ChatMessage>();
  for (const message of rawMessages) {
    if (message.role === "tool" && message.toolCallId) {
      messageToolResults.set(message.toolCallId, message);
    }
  }

  let restored = rawMessages
    .filter((message) => message.role !== "tool")
    .map((message) => {
      if (message.isCompactionSummary) return message;
      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          ...message,
          toolCalls: message.toolCalls.map((toolCall) => {
            const resultMessage = messageToolResults.get(toolCall.id);
            if (resultMessage) return { ...toolCall, result: resultMessage.content };
            const eventResult = eventToolResults.get(toolCall.id);
            return eventResult
              ? { ...toolCall, result: eventResult.content, isError: eventResult.isError }
              : toolCall;
          }),
        };
      }
      if (
        message.role === "user"
        && message.name
        && message.name !== "__compaction_checkpoint__"
        && !message.name.startsWith("__native_")
      ) {
        return { ...message, agentName: message.name };
      }
      return message;
    });

  const recovered = recoverEventOnlyAssistant(events);
  if (!restored.some((message) => message.role === "assistant" && !message.isCompactionSummary) && recovered) {
    const insertAfter = restored.findLastIndex(
      (message) => message.role === "user" && !message.isCompactionSummary,
    );
    restored = insertAfter >= 0
      ? [...restored.slice(0, insertAfter + 1), recovered, ...restored.slice(insertAfter + 1)]
      : [...restored, recovered];
  }
  const visibleQuestionIds = new Set(
    restored.flatMap((message) => message.askUser?.questionId ? [message.askUser.questionId] : []),
  );
  for (const event of events) {
    if (
      event.type !== "ask_user"
      || !event.questionId
      || resolvedQuestionIds.has(event.questionId)
      || visibleQuestionIds.has(event.questionId)
    ) continue;
    visibleQuestionIds.add(event.questionId);
    restored.push({
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      askUser: {
        questionId: event.questionId,
        question: event.question ?? "",
        options: event.options,
        fields: event.fields,
        multiSelect: event.multiSelect,
      },
      timestamp: Date.now(),
    });
  }
  return restored;
}

export function mergeRefreshedSessionHistory(
  current: ChatMessage[],
  refreshed: ChatMessage[],
): ChatMessage[] {
  if (refreshed.length === 0) return current;
  if (current.length === 0) return refreshed;

  const currentKeys = current.map(sessionHistoryMessageMatchKey);
  const refreshedKeys = refreshed.map(sessionHistoryMessageMatchKey);
  const expectedStart = Math.max(0, current.length - refreshed.length);
  const userBoundaryStart = findUserBoundaryMatch(
    current,
    refreshed,
    expectedStart,
  );
  let best = { currentStart: expectedStart, length: 0, distance: Infinity };

  for (let currentIndex = 0; currentIndex < currentKeys.length; currentIndex++) {
    for (let refreshedIndex = 0; refreshedIndex < refreshedKeys.length; refreshedIndex++) {
      if (currentKeys[currentIndex] !== refreshedKeys[refreshedIndex]) continue;
      const currentStart = currentIndex - refreshedIndex;
      if (currentStart < 0) continue;
      let length = 0;
      while (
        currentIndex + length < currentKeys.length
        && refreshedIndex + length < refreshedKeys.length
        && currentKeys[currentIndex + length] === refreshedKeys[refreshedIndex + length]
      ) {
        length += 1;
      }
      const distance = Math.abs(currentStart - expectedStart);
      if (length > best.length || (length === best.length && distance < best.distance)) {
        best = { currentStart, length, distance };
      }
    }
  }

  const replacementStart = userBoundaryStart ?? (best.length > 0 ? best.currentStart : expectedStart);
  const stableRefreshed = refreshed.map((message, index) => {
    const previous = current[replacementStart + index];
    if (!previous || !sessionHistoryMessagesAlign(previous, message, refreshedKeys[index])) return message;
    const hasPersistedImage = message.presentation?.attachments?.some((attachment) => attachment.dataUrl);
    return {
      ...message,
      id: previous.id,
      timestamp: previous.timestamp,
      images: hasPersistedImage ? undefined : message.images ?? previous.images,
    };
  });
  const queued = current.filter((message) => message.isQueued);
  return [...current.slice(0, replacementStart).filter((message) => !message.isQueued), ...stableRefreshed, ...queued];
}

function findUserBoundaryMatch(
  current: ChatMessage[],
  refreshed: ChatMessage[],
  expectedStart: number,
): number | null {
  const refreshedBoundary = refreshed[0];
  if (refreshedBoundary?.role !== "user") return null;
  const refreshedKey = sessionHistoryUserBoundaryKey(refreshedBoundary);
  let best: { start: number; distance: number } | null = null;
  for (let currentIndex = 0; currentIndex < current.length; currentIndex += 1) {
    if (current[currentIndex].role !== "user" || current[currentIndex].isQueued) continue;
    if (sessionHistoryUserBoundaryKey(current[currentIndex]) !== refreshedKey) continue;
    const distance = Math.abs(currentIndex - expectedStart);
    if (!best || distance < best.distance) best = { start: currentIndex, distance };
  }
  return best?.start ?? null;
}

function sessionHistoryMessagesAlign(
  current: ChatMessage,
  refreshed: ChatMessage,
  refreshedKey: string,
): boolean {
  if (sessionHistoryMessageMatchKey(current) === refreshedKey) return true;
  return current.role === "user"
    && refreshed.role === "user"
    && sessionHistoryUserBoundaryKey(current) === sessionHistoryUserBoundaryKey(refreshed);
}

function sessionHistoryUserBoundaryKey(message: ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    name: message.name?.startsWith("__native_") ? undefined : message.name,
    agentName: message.agentName,
    isCompactionSummary: message.isCompactionSummary,
  });
}

function sessionHistoryMessageMatchKey(message: ChatMessage): string {
  return JSON.stringify({
    role: message.role,
    content: message.content,
    toolCalls: message.toolCalls,
    toolCallId: message.toolCallId,
    name: message.name,
    agentName: message.agentName,
    presentation: message.role === "user" ? undefined : message.presentation,
    isCompactionSummary: message.isCompactionSummary,
  });
}

function toChatMessage(message: NonNullable<SessionHistoryDetail["messages"]>[number]): ChatMessage {
  if (message.name === "__compaction_checkpoint__") {
    let summary = "";
    try {
      summary = (JSON.parse(message.content ?? "{}") as { summary?: string }).summary ?? "";
    } catch {
      // Invalid legacy checkpoints render as an empty boundary marker.
    }
    return {
      id: crypto.randomUUID(),
      role: "user",
      content: summary,
      name: message.name,
      isCompactionSummary: true,
      timestamp: Date.now(),
    };
  }
  return {
    id: crypto.randomUUID(),
    role: message.role as "user" | "assistant" | "tool",
    content: message.content ?? "",
    toolCalls: message.toolCalls?.length ? message.toolCalls : undefined,
    toolCallId: message.toolCallId,
    name: message.name,
    presentation: message.presentation,
    timestamp: Date.now(),
  };
}

function recoverEventOnlyAssistant(events: PersistedHistoryEvent[]): ChatMessage | null {
  let content = "";
  const toolCalls: NonNullable<ChatMessage["toolCalls"]> = [];
  const toolCallsById = new Map<string, NonNullable<ChatMessage["toolCalls"]>[number]>();
  for (const event of events) {
    if (event.type === "text_chunk" && event.text) content += event.text;
    if (event.type === "tool_call" && event.toolCall) {
      const toolCall = {
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments,
      };
      toolCalls.push(toolCall);
      toolCallsById.set(toolCall.id, toolCall);
    }
    if (event.type === "tool_result" && event.result?.toolCallId) {
      const toolCall = toolCallsById.get(event.result.toolCallId);
      if (toolCall) {
        toolCall.result = event.result.content ?? "";
        toolCall.isError = event.result.isError;
      }
    }
  }
  if (!content.trim() && toolCalls.length === 0) return null;
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content: content.trim(),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    timestamp: Date.now(),
  };
}
