import type { CatalogSession, SessionCatalogPage } from "../../../../core/src/domain/supervision/types";
import { catalogPageSessions, isExpiredSessionCatalogCursor, mergeCatalogSessions } from "../../lib/all-sessions";
import { isCatalogSession } from "../../lib/all-sessions-cache";

const CACHE_KEY = "agentroam.task-session-catalog.v1";
const PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

export interface TaskCatalogCache {
  rows: CatalogSession[];
  count: number;
}

export interface TaskCatalogWindow extends TaskCatalogCache {
  cursor: string | null;
  refreshing?: boolean;
}

export function readTaskCatalogCache(): TaskCatalogCache | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "null") as TaskCatalogCache | null;
    if (!value || !Array.isArray(value.rows) || !value.rows.every(isCatalogSession)
      || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > value.rows.length) return null;
    return { rows: value.rows, count: value.count };
  } catch {
    return null;
  }
}

export function writeTaskCatalogCache({ rows, count }: TaskCatalogCache): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ rows, count }));
  } catch {
    // Keep the picker usable when browser storage is unavailable.
  }
}

export async function readTaskCatalogWindow(
  read: (cursor: string | undefined, limit: number) => Promise<SessionCatalogPage>,
  previous: TaskCatalogWindow,
  more: boolean,
  signal: AbortSignal,
): Promise<TaskCatalogWindow> {
  const load = async (cursor: string | undefined, limit: number) => {
    signal.throwIfAborted();
    const page = await read(cursor, limit);
    signal.throwIfAborted();
    if (cursor && (page.nextCursor === cursor || (page.nextCursor && !page.data.length))) {
      throw new Error("会话分页标记无效，请刷新");
    }
    return page;
  };
  if (more && previous.cursor) {
    try {
      const page = await load(previous.cursor, PAGE_SIZE);
      return { rows: mergeCatalogSessions(previous.rows, catalogPageSessions(page)),
        count: previous.count + page.data.length, cursor: page.nextCursor };
    } catch (error) {
      if (!isExpiredSessionCatalogCursor(error)) throw error;
    }
  }

  // Restore the number of results already loaded using a single new snapshot.
  // Ancestors are visible rows, but don't consume results or advance the cursor.
  const target = Math.max(PAGE_SIZE, previous.count + (more ? PAGE_SIZE : 0));
  let page = await load(undefined, Math.min(target, MAX_PAGE_SIZE));
  if (page.refreshing) return { ...previous, rows: mergeCatalogSessions(previous.rows, catalogPageSessions(page)), refreshing: true };
  let count = page.data.length;
  let rows = catalogPageSessions(page);
  while (count < target && page.nextCursor) {
    page = await load(page.nextCursor, Math.min(target - count, MAX_PAGE_SIZE));
    count += page.data.length;
    rows = mergeCatalogSessions(rows, catalogPageSessions(page));
  }
  return { rows, count, cursor: page.nextCursor };
}
