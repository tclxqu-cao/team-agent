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

export function reconcileDurableQueuedMessages<T extends DurableQueuedMessageLike>(
  messages: T[],
  items: DurableQueueItemLike[],
): T[] {
  const history = messages.filter((message) => !message.isQueued);
  const currentByQueueId = new Map(
    messages
      .filter((message) => message.isQueued && message.queueItemId)
      .map((message) => [message.queueItemId!, message]),
  );
  const queued = items
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
