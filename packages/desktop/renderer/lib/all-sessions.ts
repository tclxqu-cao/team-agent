import type { CatalogSession, SessionCatalogPage } from "../../../core/src/domain/supervision/types";

/** Fetch one window only; later cursors are requested by scrolling, never eagerly. */
export async function readSessionCatalogPage(
  read: (cursor?: string) => Promise<SessionCatalogPage>,
  signal: AbortSignal,
  cursor?: string,
): Promise<SessionCatalogPage> {
  signal.throwIfAborted();
  let page: SessionCatalogPage;
  try {
    page = await read(cursor);
  } catch (error) {
    signal.throwIfAborted();
    if (!cursor || !(error instanceof Error) || !/会话列表已更新|会话分页标记无效/.test(error.message)) throw error;
    // Retain visible rows while replacing an expired snapshot's cursor.
    page = await read();
  }
  signal.throwIfAborted();
  if (page.nextCursor && page.nextCursor === cursor) throw new Error("历史会话分页已失效，请刷新重试");
  return { ...page, data: mergeCatalogSessions([], page.data) };
}

export function mergeCatalogSessions(existing: readonly CatalogSession[], page: readonly CatalogSession[]): CatalogSession[] {
  return [...new Map([...existing, ...page].map(session => [session.id, session])).values()];
}

export type CatalogSessionReceipt = Omit<CatalogSession, "status"> & { status: string };

export function catalogSessionReceipt(session: CatalogSessionReceipt): CatalogSession {
  const status = session.status === "active" ? "running"
    : session.status === "running" || session.status === "completed" || session.status === "failed" ? session.status : "idle";
  return { id: session.id, agentType: session.agentType, title: session.title, cwd: session.cwd,
    projectId: session.projectId, updated: session.updated, status, canResume: session.canResume,
    occupancy: session.occupancy, readOnly: session.readOnly };
}

/** Create receipts stay visible until discovery confirms them, even over a stale first page. */
export function mergeCatalogReceipts(
  sessions: readonly CatalogSession[], receipts: readonly CatalogSession[], query: string,
): CatalogSession[] {
  const search = query.trim().toLocaleLowerCase();
  const known = new Set(sessions.map(session => session.id));
  return [...sessions, ...receipts.filter(session => !known.has(session.id)
    && `${session.title} ${session.cwd} ${session.agentType}`.toLocaleLowerCase().includes(search))];
}

/** A head refresh must not discard an expanded immutable history window. */
export function refreshCatalogWindow(
  previous: { rows: CatalogSession[]; cursor: string | null }, page: SessionCatalogPage,
): { rows: CatalogSession[]; cursor: string | null } {
  const expanded = previous.rows.length > 20;
  return { rows: expanded ? mergeCatalogSessions(previous.rows, page.data) : page.data,
    cursor: expanded && previous.cursor ? previous.cursor : page.nextCursor };
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
