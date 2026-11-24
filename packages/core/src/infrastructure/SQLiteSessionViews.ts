import type { SessionView, SessionViewPage, SessionViewRepository } from "../application/session/SyncSessionViews.js";
import { getDatabase } from "./SQLiteDatabase.js";

export class SQLiteSessionViews implements SessionViewRepository {
  constructor(private readonly baseDir: string) {}

  sync(afterRevision: number, views: readonly SessionView[], pageSize: number): SessionViewPage {
    const { db } = getDatabase(this.baseDir);
    if (views.length) {
      const upsert = db.prepare(`
        INSERT INTO session_views(session_id, viewed_at, revision)
        VALUES (@sessionId, @viewedAt, (SELECT COALESCE(MAX(revision), 0) + 1 FROM session_views))
        ON CONFLICT(session_id) DO UPDATE SET viewed_at = excluded.viewed_at, revision = excluded.revision
        WHERE excluded.viewed_at > session_views.viewed_at
      `);
      db.transaction(() => {
        for (const view of views) upsert.run(view);
      }).immediate();
    }
    const { revision } = db.prepare("SELECT COALESCE(MAX(revision), 0) AS revision FROM session_views").get() as { revision: number };
    const cursor = afterRevision > revision ? 0 : afterRevision;
    const changes = db.prepare(`
      SELECT session_id AS sessionId, viewed_at AS viewedAt, revision
      FROM session_views WHERE revision > ? ORDER BY revision LIMIT ?
    `).all(cursor, pageSize + 1) as Array<SessionView & { revision: number }>;
    const hasMore = changes.length > pageSize;
    const page = changes.slice(0, pageSize);
    return { views: page.map(({ sessionId, viewedAt }) => ({ sessionId, viewedAt })),
      revision: page.at(-1)?.revision ?? cursor, hasMore };
  }
}
