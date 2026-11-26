import type { MessagePresentation } from "@agent/core";

export interface QueuedMessageLike {
  id: string;
  isQueued?: boolean;
}

export interface UserMessageLike extends QueuedMessageLike {
  role: string;
  sendState?: "pending" | "failed";
}

export interface DurableQueueItemLike {
  id: string;
  status?: "queued" | "active" | "completed" | "failed" | "cancelled";
  objective: string;
  sourceMessageId?: string;
  createdAt: number;
  kind?: "goal" | "message";
  lastReason?: string;
  messagePayload?: {
    images?: string[];
    agentName?: string;
  };
}

export interface DurableQueuedMessageLike extends UserMessageLike {
  content: string;
  timestamp: number;
  agentName?: string;
  images?: string[];
  queueItemId?: string;
  isSteering?: boolean;
  isSteered?: boolean;
  isGoal?: boolean;
  isCompactionSummary?: boolean;
  goalHistoryAnchor?: string | null;
  sourceMessageId?: string;
  awaitingHistory?: boolean;
  presentation?: Pick<MessagePresentation, "executionTrace" | "forkPoint" | "isGoal">;
}

export interface MixedQueueStateLike<T extends DurableQueueItemLike> {
  active: T | null;
  queued: T[];
  history: T[];
}

export function findLatestUnqueuedUserMessageId<T extends UserMessageLike>(messages: T[]): string | null {
  return [...messages].reverse().find((message) => message.role === "user" && !message.isQueued)?.id ?? null;
}

export function findLatestPendingUserMessageId<T extends UserMessageLike>(messages: T[]): string | null {
  return [...messages].reverse().find(
    (message) => message.role === "user" && !message.isQueued && message.sendState === "pending",
  )?.id ?? null;
}

export function hideQueuedGoalMessages<T extends { id: string }>(
  messages: T[],
  queuedGoals: Array<{ sourceMessageId?: string }>,
): T[] {
  const queuedMessageIds = new Set(
    queuedGoals.flatMap((goal) => goal.sourceMessageId ? [goal.sourceMessageId] : []),
  );
  if (queuedMessageIds.size === 0) return messages;
  return messages.filter((message) => !queuedMessageIds.has(message.id));
}

function normalizedGoalText(value: string): string {
  return value.trim().replace(/^\/goal\s+/i, "").replace(/^\$([\w-]+)/, "/$1").trim();
}

export function transcriptGoalMessageIds(
  messages: readonly DurableQueuedMessageLike[], goals: readonly (DurableQueueItemLike | null)[],
): Set<string> {
  const marked = new Set<string>();
  const sources = new Set<string>();
  const remaining = new Map<string, number>();
  const candidates = new Map<string, string[]>();
  for (const goal of goals) {
    if (!goal || goal.kind === "message") continue;
    sources.add(goal.sourceMessageId ?? goal.id);
    const text = normalizedGoalText(goal.objective);
    remaining.set(text, (remaining.get(text) ?? 0) + 1);
  }
  for (const message of messages) {
    if (message.role !== "user" || message.isQueued || message.isCompactionSummary) continue;
    const text = normalizedGoalText(message.content);
    if (message.isGoal || message.presentation?.isGoal || sources.has(message.sourceMessageId ?? message.id)) {
      marked.add(message.id);
      remaining.set(text, (remaining.get(text) ?? 0) - 1);
    } else if (remaining.has(text) && !message.isSteered && !message.presentation?.executionTrace) {
      const group = candidates.get(text) ?? [];
      group.push(message.id);
      candidates.set(text, group);
    }
  }
  // Older histories have only text. Give them a marker only when the
  // executed goals account for every remaining input with that text.
  for (const [text, ids] of candidates) {
    if (ids.length <= (remaining.get(text) ?? 0)) ids.forEach(id => marked.add(id));
  }
  return marked;
}

export function markDurableMessageSteered<T extends DurableQueuedMessageLike>(
  messages: T[],
  messageId: string,
  steeredAt: number = Date.now(),
): T[] {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index < 0) return messages;
  const message = messages[index];
  const steered = {
    ...message,
    timestamp: steeredAt,
    isQueued: false,
    isSteering: undefined,
    isSteered: true,
    sourceMessageId: message.sourceMessageId ?? message.id,
    awaitingHistory: true,
    queueItemId: undefined,
    sendState: undefined,
  } as T;
  return [...messages.slice(0, index), ...messages.slice(index + 1), steered];
}

function findActiveNativeInput(
  history: DurableQueuedMessageLike[],
  activeItem: DurableQueueItemLike,
  activeMessageId: string,
  isGoal = false,
): number {
  const latestNativeUserIndex = history.findLastIndex((message) => (
    message.role === "user" && message.presentation?.executionTrace
  ));
  const turnId = history[latestNativeUserIndex]?.presentation?.executionTrace?.turnId;
  if (!turnId) return -1;
  // A new optimistic input or a completed turn must not consume an older,
  // equal input. Same-turn steering can only follow the active initial input.
  if (history.slice(latestNativeUserIndex + 1).some((message) => (
    message.role === "user" && message.id !== activeMessageId && message.queueItemId !== activeItem.id
  ))) return -1;
  if (history.some((message) => (
    message.role === "assistant" && message.presentation?.forkPoint?.turnId === turnId
  ))) return -1;
  return history.findIndex((message) => (
    message.role === "user"
    && message.presentation?.executionTrace?.turnId === turnId
    && (message.presentation.executionTrace.segmentIndex ?? 0) === 0
    && Boolean(message.presentation.isGoal) === isGoal
    && message.content === activeItem.objective
    && (message.agentName === undefined || message.agentName === activeItem.messagePayload?.agentName)
  ));
}

function findPromotedGoalInput(
  history: DurableQueuedMessageLike[], goal: DurableQueueItemLike, local: DurableQueuedMessageLike,
): number {
  const source = history.findIndex(row => row.role === "user" && (row.id === local.id || row.sourceMessageId === local.id));
  if (source >= 0) return source;
  const anchor = local.goalHistoryAnchor;
  if (anchor === undefined) return findActiveNativeInput(history, goal, local.id, true);
  const boundary = anchor === null ? -1 : history.findIndex(row => row.id === anchor || row.sourceMessageId === anchor);
  if (anchor !== null && boundary < 0) return -1;
  // Only a new initial input can acknowledge the local goal. Earlier equal
  // prompts and same-turn steering keep their own message identities.
  for (let index = history.length - 1; index > boundary; index--) {
    const row = history[index];
    if (row.role !== "user" || row.isSteered || row.isCompactionSummary || (row.presentation?.executionTrace?.segmentIndex ?? 0) > 0) continue;
    return row.content === goal.objective && !row.awaitingHistory && !row.sendState
      && (!row.presentation?.executionTrace || row.presentation.isGoal === true) ? index : -1;
  }
  return -1;
}

export function reconcileDurableQueuedMessages<T extends DurableQueuedMessageLike>(
  messages: T[],
  state: MixedQueueStateLike<DurableQueueItemLike>,
): T[] {
  const completed = state.history.filter(item => item.kind === "message" && item.status === "completed");
  const completedBySource = new Map(completed.map(item => [item.sourceMessageId || item.id, item]));
  const waitingMessageIds = new Set(state.queued.filter(item => item.kind === "message")
    .flatMap(item => [item.id, item.sourceMessageId].filter(Boolean)));
  let history = messages.flatMap((message): T[] => {
    if (!message.isQueued) {
      // A deferred admission can restore an optimistic active input to the
      // queue. Its source identity must move with it, without hiding native input.
      if (message.role === "user" && !message.isSteered && !message.presentation?.executionTrace
        && (waitingMessageIds.has(message.id) || waitingMessageIds.has(message.queueItemId))) return [];
      return [message];
    }
    const item = completedBySource.get(message.id) ?? completed.find(candidate => candidate.id === message.queueItemId);
    if (!item) return [];
    const persisted = messages.some(candidate => candidate !== message && !candidate.isQueued
      && candidate.role === "user" && (candidate.id === item.sourceMessageId
        || candidate.queueItemId === item.id
        || (candidate.content === item.objective && candidate.timestamp >= message.timestamp)));
    return persisted ? [] : [{ ...message, isQueued: false, queueItemId: undefined, sendState: undefined,
      awaitingHistory: true,
      ...(item.lastReason === "steered" ? { isSteered: true, isSteering: undefined, sourceMessageId: item.sourceMessageId ?? message.id } : {}),
    }];
  });
  const steeredMessageIds = new Set(history
    .filter((message) => message.role === "user" && message.isSteered)
    .flatMap((message) => message.sourceMessageId ? [message.id, message.sourceMessageId] : [message.id]));
  const currentByQueueId = new Map(
    messages
      .filter((message) => message.isQueued && message.queueItemId)
      .map((message) => [message.queueItemId!, message]),
  );
  const activeItem = state.active?.kind === "message"
    && !steeredMessageIds.has(state.active.sourceMessageId || state.active.id)
    ? state.active : null;
  if (activeItem) {
    const current = currentByQueueId.get(activeItem.id);
    const activeMessageId = activeItem.sourceMessageId || current?.id || activeItem.id;
    const nativeInputIndex = current ? -1 : findActiveNativeInput(history, activeItem, activeMessageId);
    const latestUserIndex = history.findLastIndex((message) => message.role === "user" && !message.isSteered);
    const historyIndex = nativeInputIndex >= 0 ? nativeInputIndex : history.findLastIndex((message, index) => (
      message.id === activeMessageId
      || message.queueItemId === activeItem.id
      || (
        !current
        && index === latestUserIndex
        && message.role === "user"
        && !message.presentation?.executionTrace
        && message.content === activeItem.objective
      )
    ));
    const previous = historyIndex >= 0 ? history[historyIndex] : current;
    const source = current ?? history.find((message) => message.id === activeMessageId);
    const hasSubsequentRuntimeActivity = historyIndex >= 0
      && history.slice(historyIndex + 1).some((message) => message.role === "assistant");
    const activeMessage = {
      ...(previous ?? {}),
      id: previous?.id || activeMessageId,
      role: "user",
      content: activeItem.objective,
      timestamp: previous?.timestamp ?? activeItem.createdAt,
      agentName: previous?.agentName ?? source?.agentName ?? activeItem.messagePayload?.agentName,
      images: previous?.images ?? source?.images ?? activeItem.messagePayload?.images,
      isQueued: false,
      queueItemId: undefined,
      ...(previous && "sendState" in previous
        ? { sendState: previous.sendState }
        : hasSubsequentRuntimeActivity
          ? {}
          : { sendState: "pending" as const }),
    } as T;
    if (historyIndex >= 0) history[historyIndex] = activeMessage;
    else history.push(activeMessage);
    if (nativeInputIndex >= 0) {
      // Repair the old source-ID projection while retaining every native
      // steering input, including genuine repeated text with distinct IDs.
      history = history.filter((message, index) => (
        index === nativeInputIndex
        || message.role !== "user"
        || message.presentation?.executionTrace
        || message.content !== activeItem.objective
        || (message.id !== activeMessageId && message.queueItemId !== activeItem.id)
      ));
    }
  }

  const queued = state.queued
    .filter((item) => item.kind === "message"
      && !steeredMessageIds.has(item.sourceMessageId || item.id))
    .map((item) => {
      const current = currentByQueueId.get(item.id);
      return {
        ...(current ?? {}),
        id: item.sourceMessageId || current?.id || item.id,
        role: "user",
        content: item.objective,
        timestamp: current?.timestamp ?? item.createdAt,
        agentName: item.messagePayload?.agentName,
        images: item.messagePayload?.images,
        isQueued: true,
        queueItemId: item.id,
      } as T;
    });
  const confirmedIds = new Set([state.active, ...state.queued, ...state.history]
    .flatMap(item => item ? [item.id, item.sourceMessageId].filter(Boolean) : []));
  const queuedGoalSources = new Set(state.queued.filter(item => item.kind !== "message")
    .map(item => item.sourceMessageId || item.id));
  const activeGoal = state.active?.kind !== "message" ? state.active : null;
  const pendingGoals = messages.filter(message => message.isGoal && message.isQueued);
  const promotedGoal = activeGoal && messages.find(message => message.isGoal && (message.isQueued || message.awaitingHistory)
    && message.id === (activeGoal.sourceMessageId || activeGoal.id));
  if (activeGoal && promotedGoal) {
    const transcript = promotedGoal.isQueued ? history : history.filter(row => row !== promotedGoal);
    const index = findPromotedGoalInput(transcript, activeGoal, promotedGoal);
    if (index >= 0) {
      history = transcript;
      const native = history[index];
      history[index] = { ...native, isGoal: true, sourceMessageId: promotedGoal.id,
        ...(promotedGoal.images?.length && !native.images ? { images: promotedGoal.images } : {}) };
    } else if (promotedGoal.isQueued) {
      history.push({ ...promotedGoal, content: activeGoal.objective, isQueued: false, awaitingHistory: true });
    }
  }
  const steeredGoalSources = new Set(state.history.filter(item => item.kind !== "message" && item.lastReason === "steered")
    .map(item => item.sourceMessageId || item.id));
  for (const message of pendingGoals) {
    if (steeredGoalSources.has(message.id)) {
      history = markDurableMessageSteered([...history, message], message.id);
    }
  }
  // Steering consumes the broker queue before its HTTP acknowledgement reaches
  // the renderer. Keep that input until the steering request settles locally.
  const unconfirmed = messages.filter(message => message.isQueued && !message.isGoal && (!message.queueItemId || message.isSteering)
    && !confirmedIds.has(message.id) && !confirmedIds.has(message.queueItemId)
    && !history.some(candidate => candidate.id === message.id));
  const latestInputId = pendingGoals.length ? findLatestUnqueuedUserMessageId(history) : null;
  const waitingGoals = pendingGoals.filter(message => queuedGoalSources.has(message.id) || !confirmedIds.has(message.id))
    .map(message => queuedGoalSources.has(message.id)
      ? { ...message, goalHistoryAnchor: latestInputId } : message);
  return [...history, ...queued, ...unconfirmed, ...waitingGoals];
}

export function queuedSessionMessages<T extends DurableQueueItemLike>(
  state: MixedQueueStateLike<T>,
): T[] {
  return state.queued.filter((item) => item.kind === "message");
}

export function projectSessionGoals<T extends DurableQueueItemLike>(
  state: MixedQueueStateLike<T>,
): MixedQueueStateLike<T> {
  return {
    active: state.active?.kind === "message" ? null : state.active,
    queued: state.queued.filter((item) => item.kind !== "message"),
    history: state.history.filter((item) => item.kind !== "message"),
  };
}

/** Reorder queued slots without moving any already-rendered history entries. */
export function moveQueuedMessage<T extends QueuedMessageLike>(
  messages: T[],
  sourceId: string,
  targetId: string,
): T[] {
  if (sourceId === targetId) return messages;

  const queued = messages.filter((message) => message.isQueued);
  const from = queued.findIndex((message) => message.id === sourceId);
  const to = queued.findIndex((message) => message.id === targetId);
  if (from < 0 || to < 0) return messages;

  const reordered = [...queued];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);

  let queuedIndex = 0;
  return messages.map((message) => message.isQueued ? reordered[queuedIndex++] : message);
}
