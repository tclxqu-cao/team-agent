import type {
  AgentType,
  MessagePresentation,
  SessionHistoryQuery,
  SessionToolResultRef,
} from "@agent/core";
import type { ChatMessage, ContextUsageSnapshot } from "../stores/agentStore";
import type { SessionGoalState } from "../global";
import {
  applyCodexLiveExecutionEvent,
  groupCodexExecutionTrace,
  isCodexExecutionCarrier,
  type CodexLiveExecutionEvent,
} from "./codex-execution-trace";

export interface PersistedHistoryEvent {
  type?: string;
  text?: string;
  finalText?: string;
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  result?: { toolCallId?: string; content?: string; isError?: boolean };
  turnId?: string;
  itemId?: string;
  messagePhase?: "commentary" | "final_answer";
  sectionIndex?: number;
  delta?: string;
  usage?: ContextUsageSnapshot;
  questionId?: string;
  question?: string;
  options?: Array<{ label: string; description: string }>;
  fields?: Array<{ name: string; label: string; description?: string; type?: "text" | "secret" }>;
  multiSelect?: boolean;
}

export interface SessionHistoryDetail {
  agentType?: "customer-agent" | "codex" | "claude-code" | "opencode";
  status?: "active" | "idle" | "running" | "completed" | "failed";
  occupancy?: "available" | "owned-by-customer-agent" | "owned-externally";
  messages?: Array<{
    historyId?: string;
    role?: string;
    content?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    toolResultRef?: SessionToolResultRef;
    name?: string;
    presentation?: MessagePresentation;
  }>;
  events?: PersistedHistoryEvent[];
  history?: {
    nextCursor?: string | null;
    hasMore?: boolean;
    pageSize?: number;
    totalItems?: number;
    olderCursor?: string | null;
    newerCursor?: string | null;
    kind?: "latest" | "anchored";
    revision?: string;
    delivery?: "core" | "trace" | "legacy-full";
  };
  goalState?: SessionGoalState;
}

export type ProgressiveHistoryPhase = "full" | "core" | "trace";

interface SessionHistoryApi {
  getSession(id: string, query?: SessionHistoryQuery): Promise<unknown>;
}

export async function loadCodexExecutionTracePage(
  api: SessionHistoryApi,
  sessionId: string,
  trace: { turnId: string; revision: string },
  limit = 50,
): Promise<{ detail: SessionHistoryDetail | null; revision: string; recovered: boolean }> {
  const requestTrace = (revision: string) => api.getSession(sessionId, {
    view: "trace",
    revision,
    turnId: trace.turnId,
  }) as Promise<SessionHistoryDetail | null>;

  try {
    return { detail: await requestTrace(trace.revision), revision: trace.revision, recovered: false };
  } catch (error) {
    if ((error as { code?: string }).code !== "STALE_SESSION_ANCHOR") throw error;
  }

  const core = await api.getSession(sessionId, { view: "core", limit }) as SessionHistoryDetail | null;
  const revision = core?.history?.revision;
  if (!revision) throw new Error("会话内容已更新，请刷新后重试");
  return { detail: await requestTrace(revision), revision, recovered: true };
}

export async function loadProgressiveSessionHistoryPage(
  api: SessionHistoryApi,
  sessionId: string,
  agentType: AgentType | undefined,
  query: SessionHistoryQuery,
  onPage: (detail: SessionHistoryDetail | null, phase: ProgressiveHistoryPhase) => void,
  isCurrent: () => boolean,
  coreLoader?: () => Promise<SessionHistoryDetail | null>,
): Promise<void> {
  if (agentType !== "codex") {
    const detail = coreLoader
      ? await coreLoader()
      : await api.getSession(sessionId, query) as SessionHistoryDetail | null;
    if (isCurrent()) onPage(detail, "full");
    return;
  }

  const core = coreLoader
    ? await coreLoader()
    : await api.getSession(sessionId, { ...query, view: "core" }) as SessionHistoryDetail | null;
  if (!isCurrent()) return;
  onPage(core, "core");
}

export function mergeProgressiveSessionHistoryPage(
  current: ChatMessage[],
  refreshed: ChatMessage[],
  phase: ProgressiveHistoryPhase,
  history?: SessionHistoryDetail["history"],
): ChatMessage[] {
  const traceWillFollow = phase === "core"
    && history?.delivery !== "legacy-full"
    && Boolean(history?.revision);
  const hasVisibleHistory = current.some((message) => !message.isQueued);
  if (traceWillFollow && hasVisibleHistory) {
    return mergeCoreSessionHistory(current, refreshed);
  }
  return mergeRefreshedSessionHistory(current, refreshed);
}

function mergeCoreSessionHistory(
  current: ChatMessage[],
  refreshed: ChatMessage[],
): ChatMessage[] {
  if (refreshed.length === 0) return current;
  if (current.length === 0) return refreshed;

  let currentHistory = current.filter((message) => !message.isQueued);
  const queued = current.filter((message) => message.isQueued);
  const refreshedTurnStart = refreshed.findLastIndex((message) => (
    message.role === "user" && !message.isCompactionSummary
  ));
  if (refreshedTurnStart < 0) return current;

  const refreshedUser = refreshed[refreshedTurnStart];
  let currentTurnStart = currentHistory.findLastIndex((message) => (
    message.role === "user"
    && !message.isCompactionSummary
    && sessionHistoryUserBoundaryKey(message) === sessionHistoryUserBoundaryKey(refreshedUser)
  ));

  if (currentTurnStart < 0) {
    // A new native turn can appear between core refreshes. Keep the previous
    // turn's trace and append the new core-only turn until its trace arrives.
    return [...currentHistory, ...refreshed.slice(refreshedTurnStart), ...queued];
  }

  const mergedPrefix = mergeRefreshedSessionHistory(
    currentHistory.slice(0, currentTurnStart),
    refreshed.slice(0, refreshedTurnStart),
  );
  currentHistory = [...mergedPrefix, ...currentHistory.slice(currentTurnStart)];
  currentTurnStart = mergedPrefix.length;

  const currentTurnEnd = currentHistory.findIndex((message, index) => (
    index > currentTurnStart && message.role === "user" && !message.isCompactionSummary
  ));
  const insertionIndex = currentTurnEnd < 0 ? currentHistory.length : currentTurnEnd;
  const currentAssistantIndexes: number[] = [];
  for (let index = currentTurnStart + 1; index < insertionIndex; index += 1) {
    if (isCoreAssistantMessage(currentHistory[index])) currentAssistantIndexes.push(index);
  }
  const refreshedAssistants = refreshed
    .slice(refreshedTurnStart + 1)
    .filter(isCoreAssistantMessage);
  const refreshedRevision = refreshed.find((message) => message.executionTrace)?.executionTrace?.revision;
  const merged = currentHistory.map((message) => message.executionTrace && refreshedRevision
    ? {
        ...message,
        executionTrace: { ...message.executionTrace, revision: refreshedRevision },
      }
    : message);
  const refreshedTrace = refreshed
    .slice(refreshedTurnStart + 1)
    .find((message) => message.executionTrace);
  const currentTraceIndex = currentHistory.findIndex((message, index) => (
    index > currentTurnStart
    && index < insertionIndex
    && message.executionTrace?.turnId === refreshedTrace?.executionTrace?.turnId
  ));
  if (refreshedTrace && currentTraceIndex >= 0) {
    const currentTrace = currentHistory[currentTraceIndex].executionTrace;
    merged[currentTraceIndex] = {
      ...refreshedTrace,
      id: currentHistory[currentTraceIndex].id,
      timestamp: currentHistory[currentTraceIndex].timestamp,
      executionTrace: {
        ...refreshedTrace.executionTrace!,
        ...(currentTrace?.liveMessages ? { liveMessages: currentTrace.liveMessages } : {}),
      },
    };
  }
  const shared = Math.min(currentAssistantIndexes.length, refreshedAssistants.length);

  for (let index = 0; index < shared; index += 1) {
    const currentIndex = currentAssistantIndexes[index];
    const previous = merged[currentIndex];
    const next = refreshedAssistants[index];
    merged[currentIndex] = {
      ...previous,
      ...next,
      id: next.id.startsWith("history-message.v1.") ? next.id : previous.id,
      timestamp: previous.timestamp,
      images: next.images ?? previous.images,
      presentation: next.presentation ?? previous.presentation,
    };
  }

  if (refreshedAssistants.length > shared) {
    merged.splice(insertionIndex, 0, ...refreshedAssistants.slice(shared));
  }
  return [...merged, ...queued];
}

function isCoreAssistantMessage(message: ChatMessage): boolean {
  return message.role === "assistant"
    && !message.executionTrace
    && !message.toolCalls?.length
    && !message.askUser
    && !message.isCompactionSummary
    && !message.presentation?.reasoning?.length;
}

export function restoreSessionHistoryPage(detail: SessionHistoryDetail | null): ChatMessage[] {
  const isCodexCore = detail?.history?.delivery === "core";
  const restored = restoreSessionMessages(detail, !isCodexCore);
  const revision = detail?.history?.revision;
  if (!isCodexCore || !revision) return restored;
  return restoreCodexLiveExecutionEvents(
    groupCodexExecutionTrace(restored, revision),
    detail?.events ?? [],
  );
}

export function restoreCodexExecutionTrace(detail: SessionHistoryDetail | null): ChatMessage[] {
  return restoreSessionMessages(detail).filter(isCodexExecutionCarrier);
}

function restoreSessionMessages(
  detail: SessionHistoryDetail | null,
  recoverEventTools = true,
): ChatMessage[] {
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
        const visibleToolCalls = message.toolCalls.filter((toolCall) => toolCall.name !== "ask_user");
        if (visibleToolCalls.length === 0 && !message.content.trim()) return null;
        return {
          ...message,
          toolCalls: visibleToolCalls.map((toolCall) => {
            const resultMessage = messageToolResults.get(toolCall.id);
            if (resultMessage) return {
              ...toolCall,
              ...(resultMessage.toolResultRef
                ? {
                    resultRef: resultMessage.toolResultRef,
                    isError: resultMessage.toolResultRef.isError,
                  }
                : { result: resultMessage.content }),
            };
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
    })
    .filter((message): message is ChatMessage => message !== null);

  const recovered = recoverEventOnlyAssistant(events, recoverEventTools);
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
    const toolCalls = message.toolCalls?.map((toolCall) => {
      const previousToolCall = previous.toolCalls?.find((candidate) => candidate.id === toolCall.id);
      return previousToolCall?.result === undefined
        ? toolCall
        : { ...toolCall, result: previousToolCall.result, isError: previousToolCall.isError };
    });
    const carried = carryOverOmittedAttachmentImages(previous, message);
    return {
      ...carried,
      id: message.id.startsWith("history-message.v1.") ? message.id : previous.id,
      timestamp: previous.timestamp,
      images: hasPersistedImage ? undefined : message.images ?? previous.images,
      ...(toolCalls ? { toolCalls } : {}),
    };
  });
  const queued = current.filter((message) => message.isQueued);
  const currentTail = current.slice(replacementStart).filter((message) => !message.isQueued);
  const reconciledRefreshed = preserveTrailingAssistantSuffix(currentTail, stableRefreshed);
  return [
    ...current.slice(0, replacementStart).filter((message) => !message.isQueued),
    ...reconciledRefreshed,
    ...queued,
  ];
}

/**
 * Core pages withhold image payloads beyond a server-side inline budget.
 * When a refreshed message reports an omitted attachment that the current
 * view already loaded, keep the loaded data URL instead of dropping the
 * visible image.
 */
function carryOverOmittedAttachmentImages(
  previous: ChatMessage | undefined,
  refreshed: ChatMessage,
): ChatMessage {
  const refreshedAttachments = refreshed.presentation?.attachments;
  const previousAttachments = previous?.presentation?.attachments;
  if (!refreshedAttachments?.length || !previousAttachments?.length) return refreshed;
  if (refreshedAttachments.every((attachment) => attachment.dataUrl || attachment.unavailable)) {
    return refreshed;
  }
  const carried = refreshedAttachments.map((attachment) => {
    if (attachment.dataUrl || attachment.unavailable || !attachment.omitted) return attachment;
    const match = previousAttachments.find((candidate) => (
      candidate.name === attachment.name && candidate.dataUrl
    ));
    return match ? { ...attachment, dataUrl: match.dataUrl, omitted: undefined } : attachment;
  });
  return { ...refreshed, presentation: { ...refreshed.presentation, attachments: carried } };
}

function preserveTrailingAssistantSuffix(
  current: ChatMessage[],
  refreshed: ChatMessage[],
): ChatMessage[] {
  const refreshedTurnStart = refreshed.findLastIndex((message) => message.role === "user" && !message.isQueued);
  if (refreshedTurnStart < 0) return refreshed;

  const boundaryKey = sessionHistoryUserBoundaryKey(refreshed[refreshedTurnStart]);
  let currentTurnStart = -1;
  let closestDistance = Infinity;
  for (let index = 0; index < current.length; index += 1) {
    const message = current[index];
    if (message.role !== "user" || message.isQueued) continue;
    if (sessionHistoryUserBoundaryKey(message) !== boundaryKey) continue;
    const distance = Math.abs(index - refreshedTurnStart);
    if (distance < closestDistance) {
      currentTurnStart = index;
      closestDistance = distance;
    }
  }
  if (currentTurnStart < 0) return refreshed;

  const nextCurrentTurnStart = current.findIndex((message, index) => (
    index > currentTurnStart && message.role === "user" && !message.isQueued
  ));
  const currentTurn = current.slice(
    currentTurnStart + 1,
    nextCurrentTurnStart < 0 ? current.length : nextCurrentTurnStart,
  );
  const refreshedTurn = refreshed.slice(refreshedTurnStart + 1);
  const currentText = assistantText(currentTurn);
  const refreshedText = assistantText(refreshedTurn);
  if (currentText.length <= refreshedText.length || !currentText.startsWith(refreshedText)) return refreshed;

  const suffix = currentText.slice(refreshedText.length);
  const mergeIndex = refreshed.findLastIndex((message, index) => (
    index > refreshedTurnStart
    && message.role === "assistant"
    && !message.toolCalls?.length
    && !message.askUser
    && !message.isCompactionSummary
  ));
  if (mergeIndex >= 0) {
    return refreshed.map((message, index) => index === mergeIndex
      ? { ...message, content: message.content + suffix }
      : message);
  }

  const suffixSource = currentTurn.findLast((message) => (
    message.role === "assistant"
    && Boolean(message.content)
    && !message.isCompactionSummary
  ));
  return [...refreshed, {
    id: suffixSource?.id ?? crypto.randomUUID(),
    role: "assistant",
    content: suffix,
    timestamp: suffixSource?.timestamp ?? Date.now(),
  }];
}

function assistantText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "assistant" && !message.isCompactionSummary)
    .map((message) => message.content)
    .join("");
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
  if (
    current.role === "assistant"
    && refreshed.role === "assistant"
    && current.content === refreshed.content
    && JSON.stringify(current.toolCalls?.map((toolCall) => toolCall.id) ?? [])
      === JSON.stringify(refreshed.toolCalls?.map((toolCall) => toolCall.id) ?? [])
  ) return true;
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
    toolResultRef: message.toolResultRef,
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
    id: message.historyId ?? crypto.randomUUID(),
    role: message.role as "user" | "assistant" | "tool",
    content: message.content ?? "",
    toolCalls: message.toolCalls?.length ? message.toolCalls : undefined,
    toolCallId: message.toolCallId,
    toolResultRef: message.toolResultRef,
    name: message.name,
    presentation: message.presentation,
    timestamp: Date.now(),
  };
}

function restoreCodexLiveExecutionEvents(
  messages: ChatMessage[],
  events: readonly PersistedHistoryEvent[],
): ChatMessage[] {
  return events.reduce((current, event) => {
    if (!event.turnId) return current;
    let liveEvent: CodexLiveExecutionEvent | null = null;
    if (
      event.type === "text_chunk"
      && event.messagePhase === "commentary"
      && typeof event.text === "string"
      && event.text
    ) {
      liveEvent = {
        type: "text_chunk",
        text: event.text,
        turnId: event.turnId,
        itemId: event.itemId,
        messagePhase: "commentary",
      };
    } else if (
      event.type === "reasoning_summary_delta"
      && event.itemId
      && Number.isSafeInteger(event.sectionIndex)
      && typeof event.delta === "string"
    ) {
      liveEvent = {
        type: "reasoning_summary_delta",
        turnId: event.turnId,
        itemId: event.itemId,
        sectionIndex: event.sectionIndex!,
        delta: event.delta,
      };
    } else if (event.type === "tool_call" && event.toolCall) {
      liveEvent = { type: "tool_call", turnId: event.turnId, toolCall: event.toolCall };
    } else if (event.type === "tool_result" && event.result?.toolCallId) {
      liveEvent = {
        type: "tool_result",
        turnId: event.turnId,
        result: {
          toolCallId: event.result.toolCallId,
          content: event.result.content ?? "",
          isError: event.result.isError,
        },
      };
    }
    return liveEvent
      ? applyCodexLiveExecutionEvent(current, event.turnId, liveEvent)
      : current;
  }, messages);
}

function recoverEventOnlyAssistant(
  events: PersistedHistoryEvent[],
  includeTools = true,
): ChatMessage | null {
  let content = "";
  const toolCalls: NonNullable<ChatMessage["toolCalls"]> = [];
  const toolCallsById = new Map<string, NonNullable<ChatMessage["toolCalls"]>[number]>();
  for (const event of events) {
    if (event.type === "text_chunk" && event.text) content += event.text;
    if (includeTools && event.type === "tool_call" && event.toolCall) {
      const toolCall = {
        id: event.toolCall.id,
        name: event.toolCall.name,
        arguments: event.toolCall.arguments,
      };
      toolCalls.push(toolCall);
      toolCallsById.set(toolCall.id, toolCall);
    }
    if (includeTools && event.type === "tool_result" && event.result?.toolCallId) {
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
