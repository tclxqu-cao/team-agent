import type { UnifiedSessionSummary, WorkspacePage, WorkspaceSessionQuery } from "@agent/native-runtime";

type Page = WorkspacePage<UnifiedSessionSummary>;
interface Entry {
  page?: Page;
  pending?: Promise<Page>;
  refreshAfter: number;
  failed?: boolean;
}

function mergeRefreshingPage(previous: Page, next: Page): Page {
  const seen = new Set<string>();
  const data = [...next.data, ...previous.data].filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
  return {
    ...previous,
    data,
    nextCursor: next.nextCursor ?? previous.nextCursor,
    watermark: next.watermark ?? previous.watermark,
    ...(next.stale ? { stale: true } : {}),
    refreshing: true,
  };
}

/** Keep first pages readable while slow native discovery refreshes them. */
export class WorkspaceSessionCache {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now = Date.now) {}

  clear(): void {
    this.entries.clear();
  }

  async read(key: string, query: WorkspaceSessionQuery, load: (query: WorkspaceSessionQuery) => Promise<Page>): Promise<Page> {
    // Historical cursors belong to the runtime's current pagination contract.
    if (query.cursor) return load(query);
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= 128) this.entries.delete(this.entries.keys().next().value!);
      entry = { refreshAfter: 0 };
      this.entries.set(key, entry);
    }
    if (!entry.page) {
      try {
        await (entry.pending ?? this.load(entry, { ...query, refresh: false }, load));
      } catch (error) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        throw error;
      }
    }
    if (query.refresh && this.now() >= entry.refreshAfter && !entry.pending) {
      void this.load(entry, { ...query, refresh: true }, load).catch(() => undefined);
    }
    const page = entry.page!;
    return { ...page, ...(entry.pending ? { refreshing: true } : {}), ...(entry.failed ? { stale: true } : {}) };
  }

  private load(entry: Entry, query: WorkspaceSessionQuery, load: (query: WorkspaceSessionQuery) => Promise<Page>): Promise<Page> {
    const pending = Promise.resolve().then(() => load(query)).then(page => {
      if (page.refreshing && entry.page) {
        // A native runtime can return its direct head while the complete
        // discovery catalog is still warming. Keep the visible window until
        // that catalog produces a complete page.
        entry.page = mergeRefreshingPage(entry.page, page);
      } else {
        entry.page = page;
      }
      entry.failed = false;
      // A cache read from the broker does not replace an explicit refresh.
      entry.refreshAfter = page.refreshing ? this.now() + 1_000 : query.refresh ? this.now() + 15_000 : 0;
      return page;
    }, error => {
      entry.failed = true;
      entry.refreshAfter = this.now() + 5_000;
      throw error;
    }).finally(() => {
      if (entry.pending === pending) entry.pending = undefined;
    });
    entry.pending = pending;
    return pending;
  }
}
