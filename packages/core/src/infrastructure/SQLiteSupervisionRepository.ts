import type { SupervisionRepository } from "../application/supervision/ports.js";
import type { SupervisionState } from "../domain/supervision/types.js";
import { getDatabase } from "./SQLiteDatabase.js";

/** Durable scopes and cross-group intervention leases share the host database. */
export class SQLiteSupervisionRepository implements SupervisionRepository {
  private readonly db;
  constructor(baseDir: string) {
    this.db = getDatabase(baseDir).db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS collaboration_supervision (
        group_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
        lease_owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS supervision_target_claims (
        session_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
  }
  get(groupId: string): SupervisionState | null {
    const row = this.db.prepare("SELECT payload FROM collaboration_supervision WHERE group_id=?").get(groupId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  initialize(state: SupervisionState): SupervisionState {
    this.db.prepare("INSERT INTO collaboration_supervision(group_id,payload) VALUES(?,?) ON CONFLICT(group_id) DO NOTHING").run(state.groupId, JSON.stringify(state));
    return this.get(state.groupId)!;
  }
  save(state: SupervisionState, expectedGeneration?: number): boolean {
    if (expectedGeneration !== undefined)
      return this.db.prepare("UPDATE collaboration_supervision SET payload=? WHERE group_id=? AND json_extract(payload,'$.generation')=?").run(JSON.stringify(state), state.groupId, expectedGeneration).changes === 1;
    this.db.prepare("INSERT INTO collaboration_supervision(group_id,payload) VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET payload=excluded.payload").run(state.groupId, JSON.stringify(state));
    return true;
  }
  claim(groupId: string, owner: string, now: number, ttl: number): boolean {
    return this.db.prepare("UPDATE collaboration_supervision SET lease_owner=?,lease_until=? WHERE group_id=? AND (lease_owner=? OR lease_until<?)").run(owner, now + ttl, groupId, owner, now).changes === 1;
  }
  claimTarget(sessionId: string, owner: string, now: number, ttl: number): boolean {
    return this.db.prepare(`INSERT INTO supervision_target_claims(session_id,owner,expires_at) VALUES(?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE supervision_target_claims.owner=excluded.owner OR supervision_target_claims.expires_at<?`).run(sessionId, owner, now + ttl, now).changes === 1;
  }
  internalSessionIds(): Set<string> {
    const rows = this.db.prepare("SELECT DISTINCT value FROM collaboration_supervision,json_each(collaboration_supervision.payload,'$.sessions')").all() as Array<{ value: string }>;
    return new Set(rows.map(row => row.value));
  }
}
