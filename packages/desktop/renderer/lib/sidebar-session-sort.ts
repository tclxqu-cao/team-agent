export interface SortableSidebarSession {
  created: string;
}

function stableSort<T>(
  sessions: readonly T[],
  compare: (left: T, right: T) => number,
): T[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((left, right) => compare(left.session, right.session) || left.index - right.index)
    .map(({ session }) => session);
}

/** Sort root sessions by creation time without mutating the cached session index. */
export function sortNewestSessionsFirst<T extends SortableSidebarSession>(
  sessions: readonly T[],
): T[] {
  return stableSort(sessions, (left, right) => right.created.localeCompare(left.created));
}

/** Float running sessions while preserving newest-first order inside each partition. */
export function sortRunningSessionsFirst<T extends SortableSidebarSession>(
  sessions: readonly T[],
  isRunning: (session: T) => boolean,
): T[] {
  return stableSort(
    sortNewestSessionsFirst(sessions),
    (left, right) => Number(isRunning(right)) - Number(isRunning(left)),
  );
}

/** Float pinned sessions without changing the order inside either partition. */
export function sortPinnedSessionsFirst<T>(
  sessions: readonly T[],
  isPinned: (session: T) => boolean,
): T[] {
  return stableSort(
    sessions,
    (left, right) => Number(isPinned(right)) - Number(isPinned(left)),
  );
}
