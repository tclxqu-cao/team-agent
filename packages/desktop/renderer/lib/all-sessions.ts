import type { CatalogSession, SessionCatalogPage } from "../../../core/src/domain/supervision/types";

/** One catalog snapshot covers all Agents, including directories never opened. */
export async function loadAllSessions(
  read: (cursor?: string) => Promise<SessionCatalogPage>,
  signal: AbortSignal,
  onPage: (sessions: CatalogSession[], total: number) => void,
): Promise<void> {
  const sessions = new Map<string, CatalogSession>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    signal.throwIfAborted();
    const page = await read(cursor);
    signal.throwIfAborted();
    for (const session of page.data) sessions.set(session.id, session);
    onPage([...sessions.values()], page.total);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error("历史会话分页已失效，请刷新重试");
    if (cursor) cursors.add(cursor);
  } while (cursor);
}

export function orderAllSessions(
  sessions: readonly CatalogSession[],
  pinnedIds: readonly string[],
  activeIds: readonly string[],
): CatalogSession[] {
  const pinned = new Set(pinnedIds);
  const active = new Set(activeIds);
  const running = (session: CatalogSession) => session.status === "running" || active.has(session.id);
  return [...sessions].sort((a, b) => Number(running(b)) - Number(running(a))
    || Number(pinned.has(b.id)) - Number(pinned.has(a.id))
    || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
}
