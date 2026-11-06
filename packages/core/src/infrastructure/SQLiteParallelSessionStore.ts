import type { ParallelSessionGroup, ParallelSessionIdentity } from "../domain/session/ParallelSessions.js";
import { getDatabase } from "./SQLiteDatabase.js";

export class SQLiteParallelSessionStore<T extends ParallelSessionIdentity> {
  private readonly database;

  constructor(baseDir: string) {
    this.database = getDatabase(baseDir);
    this.database.db.exec(`
      CREATE TABLE IF NOT EXISTS parallel_session_groups (
        id TEXT PRIMARY KEY, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS parallel_session_members (
        session_id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES parallel_session_groups(id) ON DELETE CASCADE
      );
    `);
  }

  create(group: ParallelSessionGroup<T>): void {
    this.database.db.transaction(() => {
      this.database.db.prepare("INSERT INTO parallel_session_groups (id, payload) VALUES (?, ?)")
        .run(group.id, JSON.stringify(group));
      const insert = this.database.db.prepare("INSERT INTO parallel_session_members (session_id, group_id) VALUES (?, ?)");
      for (const member of group.members) insert.run(member.id, group.id);
    })();
  }

  getForSession(sessionId: string): ParallelSessionGroup<T> | null {
    const row = this.database.db.prepare(`
      SELECT g.payload FROM parallel_session_groups g
      JOIN parallel_session_members m ON m.group_id = g.id WHERE m.session_id = ?
    `).get(sessionId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) as ParallelSessionGroup<T> : null;
  }
}
