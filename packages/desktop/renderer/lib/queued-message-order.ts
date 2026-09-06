export interface QueuedMessageLike {
  id: string;
  isQueued?: boolean;
}

export interface UserMessageLike extends QueuedMessageLike {
  role: string;
}

export interface DurableQueueItemLike {
  id: string;
  objective: string;
  sourceMessageId?: string;
  createdAt: number;
  kind?: "goal" | "message";
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
}

export interface MixedQueueStateLike<T extends DurableQueueItemLike> {
  active: T | null;
  queued: T[];
  history: T[];
}

export function findLatestUnqueuedUserMessageId<T extends UserMessageLike>(messages: T[]): string | null {
  return [...messages].reverse().find((message) => message.role === "user" && !message.isQueued)?.id ?? null;
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

export function reconcileDurableQueuedMessages<T extends DurableQueuedMessageLike>(
  messages: T[],
  state: MixedQueueStateLike<DurableQueueItemLike>,
): T[] {
  const history = messages.filter((message) => !message.isQueued);
  const currentByQueueId = new Map(
    messages
      .filter((message) => message.isQueued && message.queueItemId)
      .map((message) => [message.queueItemId!, message]),
  );
  const activeItem = state.active?.kind === "message" ? state.active : null;
  if (activeItem) {
    const current = currentByQueueId.get(activeItem.id);
    const activeMessageId = activeItem.sourceMessageId || current?.id || activeItem.id;
    const latestUserIndex = history.findLastIndex((message) => message.role === "user");
    const historyIndex = history.findLastIndex((message, index) => (
      message.id === activeMessageId
      || message.queueItemId === activeItem.id
      || (
        !current
        && index === latestUserIndex
        && message.role === "user"
        && message.content === activeItem.objective
      )
    ));
    const previous = historyIndex >= 0 ? history[historyIndex] : current;
    const activeMessage = {
      ...(previous ?? {}),
      id: previous?.id || activeMessageId,
      role: "user",
      content: activeItem.objective,
      timestamp: previous?.timestamp ?? activeItem.createdAt,
      agentName: previous?.agentName ?? activeItem.messagePayload?.agentName,
      images: previous?.images ?? activeItem.messagePayload?.images,
      isQueued: false,
      queueItemId: undefined,
    } as T;
    if (historyIndex >= 0) history[historyIndex] = activeMessage;
    else history.push(activeMessage);
  }

  const queued = state.queued
    .filter((item) => item.kind === "message")
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
  return [...history, ...queued];
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
