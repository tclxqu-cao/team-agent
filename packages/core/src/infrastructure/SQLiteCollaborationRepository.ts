import type { CollaborationRepository } from "../application/collaboration/ports.js";
import {
  CollaborationError,
  type CollaborationDiscussionState,
  type CollaborationDiscussionSummary,
  type CollaborationGroup,
} from "../domain/collaboration/types.js";
import { getDatabase } from "./SQLiteDatabase.js";

export class SQLiteCollaborationRepository implements CollaborationRepository {
  private readonly db;
  constructor(baseDir: string) {
    this.db = getDatabase(baseDir).db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_groups(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS collaboration_discussions(
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES collaboration_groups(id),
        payload TEXT NOT NULL, updated_at TEXT NOT NULL, lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS collaboration_history ON collaboration_discussions(group_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS collaboration_workspace_claims(
        cwd TEXT NOT NULL, holder TEXT NOT NULL, read_only INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(cwd, holder)
      );
    `);
  }
  listGroups(): CollaborationGroup[] {
    return (
      this.db
        .prepare("SELECT payload FROM collaboration_groups ORDER BY rowid DESC")
        .all() as Array<{ payload: string }>
    )
      .map((row) => JSON.parse(row.payload) as CollaborationGroup)
      .filter((group) => !group.deletedAt);
  }
  memberSessionIds(): Set<string> {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT value FROM collaboration_discussions,json_each(collaboration_discussions.payload,'$.sessions')",
      )
      .all() as Array<{ value: string }>;
    return new Set(rows.map((row) => row.value));
  }
  saveGroup(group: CollaborationGroup): void {
    this.db
      .prepare(
        "INSERT INTO collaboration_groups(id,payload) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
      )
      .run(group.id, JSON.stringify(group));
  }
  getGroup(id: string): CollaborationGroup | null {
    const row = this.db
      .prepare("SELECT payload FROM collaboration_groups WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  updateGroup(
    id: string,
    mutate: (
      group: CollaborationGroup,
      discussions: CollaborationDiscussionState[],
    ) => void,
  ): CollaborationGroup {
    return this.db.transaction(() => {
      const group = this.getGroup(id);
      if (!group) throw new CollaborationError("协作群不存在", "NOT_FOUND");
      const rows = this.db
        .prepare(
          "SELECT payload FROM collaboration_discussions WHERE group_id=?",
        )
        .all(id) as Array<{ payload: string }>;
      const discussions = rows.map(
        (row) => JSON.parse(row.payload) as CollaborationDiscussionState,
      );
      const before = discussions.map((state) => JSON.stringify(state));
      mutate(group, discussions);
      this.saveGroup(group);
      discussions.forEach((state, index) => {
        if (JSON.stringify(state) === before[index]) return;
        state.revision++;
        this.db
          .prepare("UPDATE collaboration_discussions SET payload=? WHERE id=?")
          .run(JSON.stringify(state), state.id);
      });
      return group;
    })();
  }
  createDiscussion(state: CollaborationDiscussionState): void {
    this.db
      .prepare(
        "INSERT INTO collaboration_discussions(id,group_id,payload,updated_at) VALUES(?,?,?,?)",
      )
      .run(state.id, state.groupId, JSON.stringify(state), state.updatedAt);
  }
  getDiscussion(id: string): CollaborationDiscussionState | null {
    const row = this.db
      .prepare("SELECT payload FROM collaboration_discussions WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  listDiscussions(groupId?: string): CollaborationDiscussionSummary[] {
    const sql = `SELECT d.payload FROM collaboration_discussions d
      JOIN collaboration_groups g ON g.id=d.group_id
      WHERE json_extract(g.payload,'$.deletedAt') IS NULL ${groupId ? "AND d.group_id=?" : ""}
      ORDER BY d.updated_at DESC,d.id DESC`;
    const rows = (
      groupId ? this.db.prepare(sql).all(groupId) : this.db.prepare(sql).all()
    ) as Array<{ payload: string }>;
    return rows.map(({ payload }) => {
      const { id, groupId, title, status, updatedAt } = JSON.parse(
        payload,
      ) as CollaborationDiscussionState;
      return { id, groupId, title, status, updatedAt };
    });
  }
  /** Compact projection: dashboard reads must not hydrate complete chat histories. */
  dashboardDiscussions(): Array<CollaborationDiscussionSummary & {
    progress: string; runningCount: number; revision: number; sessions: Record<string, string>;
    questions: Array<{ id: string; text: string; options?: Array<{ label: string; description: string }> }>;
  }> {
    const rows = this.db.prepare(`SELECT d.id, d.group_id AS groupId, d.updated_at AS updatedAt,
      json_extract(d.payload,'$.title') AS title, json_extract(d.payload,'$.status') AS status,
      json_extract(d.payload,'$.revision') AS revision,
      substr(coalesce(json_extract(d.payload,'$.messages[#-1].content'),''),1,600) AS progress,
      (SELECT count(*) FROM json_each(d.payload,'$.tasks') t WHERE json_extract(t.value,'$.status')='running') AS runningCount,
      coalesce(json_extract(d.payload,'$.sessions'),'{}') AS sessions,
      (SELECT json_group_array(json_object('id',json_extract(m.value,'$.question.id'),'text',substr(json_extract(m.value,'$.content'),1,8000),'options',json_extract(m.value,'$.question.options')))
        FROM json_each(d.payload,'$.messages') m WHERE json_extract(d.payload,'$.status') IN ('running','waiting') AND json_extract(m.value,'$.question.id') IS NOT NULL AND coalesce(json_extract(m.value,'$.question.resolved'),0)=0) AS questions
      FROM collaboration_discussions d JOIN collaboration_groups g ON g.id=d.group_id
      WHERE json_extract(g.payload,'$.deletedAt') IS NULL ORDER BY d.updated_at DESC,d.id DESC`).all() as Array<CollaborationDiscussionSummary & { progress: string; runningCount: number; revision: number; sessions: string; questions: string }>;
    return rows.map(row => ({ ...row, sessions: JSON.parse(row.sessions), questions: JSON.parse(row.questions) }));
  }
  updateDiscussion(
    id: string,
    mutate: (state: CollaborationDiscussionState) => void,
  ): CollaborationDiscussionState {
    return this.db.transaction(() => {
      const state = this.getDiscussion(id);
      if (!state) throw new CollaborationError("群聊记录不存在", "NOT_FOUND");
      mutate(state);
      state.revision++;
      state.updatedAt = new Date().toISOString();
      this.db
        .prepare(
          "UPDATE collaboration_discussions SET payload=?,updated_at=? WHERE id=?",
        )
        .run(JSON.stringify(state), state.updatedAt, id);
      return state;
    })();
  }
  claim(id: string, owner: string, now: number, ttl: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE collaboration_discussions SET lease_owner=?,lease_until=? WHERE id=? AND (lease_owner=? OR lease_until<?)",
        )
        .run(owner, now + ttl, id, owner, now).changes === 1
    );
  }
  release(id: string, owner: string): void {
    this.db
      .prepare(
        "UPDATE collaboration_discussions SET lease_owner=NULL,lease_until=0 WHERE id=? AND lease_owner=?",
      )
      .run(id, owner);
  }
  claimWorkspace(
    cwd: string,
    holder: string,
    now: number,
    ttl: number,
    readOnly = false,
  ): boolean {
    return this.db.transaction(() => {
      this.db
        .prepare(
          "DELETE FROM collaboration_workspace_claims WHERE expires_at<?",
        )
        .run(now);
      const conflict = this.db
        .prepare(
          "SELECT 1 FROM collaboration_workspace_claims WHERE cwd=? AND holder<>? AND (read_only=0 OR ?=0) LIMIT 1",
        )
        .get(cwd, holder, Number(readOnly));
      if (conflict) return false;
      this.db
        .prepare(
          "INSERT INTO collaboration_workspace_claims(cwd,holder,read_only,expires_at) VALUES(?,?,?,?) ON CONFLICT(cwd,holder) DO UPDATE SET read_only=excluded.read_only,expires_at=excluded.expires_at",
        )
        .run(cwd, holder, Number(readOnly), now + ttl);
      return true;
    })();
  }
  releaseWorkspace(cwd: string, holder: string): void {
    this.db
      .prepare(
        "DELETE FROM collaboration_workspace_claims WHERE cwd=? AND holder=?",
      )
      .run(cwd, holder);
  }
}
