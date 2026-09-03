export interface QueuedMessageLike {
  id: string;
  isQueued?: boolean;
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
