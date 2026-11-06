import type { CatalogSession, SessionCatalogPage } from "../../../core/src/domain/supervision/types";

/** Fetch one window only; later cursors are requested by scrolling, never eagerly. */
export async function readSessionCatalogPage(
  read: (cursor?: string) => Promise<SessionCatalogPage>,
  signal: AbortSignal,
  cursor?: string,
): Promise<SessionCatalogPage> {
  signal.throwIfAborted();
  const page = await read(cursor);
  signal.throwIfAborted();
  if (page.nextCursor && page.nextCursor === cursor) throw new Error("历史会话分页已失效，请刷新重试");
  return { ...page, data: mergeCatalogSessions([], page.data) };
}

export function mergeCatalogSessions(existing: readonly CatalogSession[], page: readonly CatalogSession[]): CatalogSession[] {
  return [...new Map([...existing, ...page].map(session => [session.id, session])).values()];
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
