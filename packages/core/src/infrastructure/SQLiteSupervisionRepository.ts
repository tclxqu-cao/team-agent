import type { SupervisionRepository } from "../application/supervision/ports.js";
import type { SupervisionMessage, SupervisionMessagePage, SupervisionMessageQuery, SupervisionState } from "../domain/supervision/types.js";
import { incidentMessage } from "../domain/supervision/messages.js";
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
      CREATE TABLE IF NOT EXISTS supervision_messages (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL, incident_id TEXT, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS supervision_messages_group ON supervision_messages(group_id,sequence);
      CREATE INDEX IF NOT EXISTS supervision_messages_incident ON supervision_messages(group_id,incident_id);
    `);
    this.backfillHistory();
  }
  get(groupId: string): SupervisionState | null {
    const row = this.db.prepare("SELECT payload FROM collaboration_supervision WHERE group_id=?").get(groupId) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : null;
  }
  initialize(state: SupervisionState): SupervisionState {
    this.db.prepare("INSERT INTO collaboration_supervision(group_id,payload) VALUES(?,?) ON CONFLICT(group_id) DO NOTHING").run(state.groupId, JSON.stringify(state));
    return this.get(state.groupId)!;
  }
  save(state: SupervisionState, expectedGeneration?: number, messages: SupervisionMessage[] = []): boolean {
    return this.db.transaction(() => {
      if (expectedGeneration !== undefined) {
        if (this.db.prepare("UPDATE collaboration_supervision SET payload=? WHERE group_id=? AND json_extract(payload,'$.generation')=?").run(JSON.stringify(state), state.groupId, expectedGeneration).changes !== 1) return false;
      } else {
        this.db.prepare("INSERT INTO collaboration_supervision(group_id,payload) VALUES(?,?) ON CONFLICT(group_id) DO UPDATE SET payload=excluded.payload").run(state.groupId, JSON.stringify(state));
      }
      for (const message of messages) this.appendMessage(message);
      return true;
    })();
  }
  appendMessage(message: SupervisionMessage): void {
    this.db.prepare("INSERT INTO supervision_messages(id,group_id,incident_id,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING")
      .run(message.id, message.groupId, message.incidentId ?? null, JSON.stringify(message));
  }
  private backfillHistory(groupId?: string): void {
    const rows = (groupId
      ? this.db.prepare("SELECT payload FROM collaboration_supervision WHERE group_id=?").all(groupId)
      : this.db.prepare("SELECT payload FROM collaboration_supervision").all()) as Array<{ payload: string }>;
    this.db.transaction(() => {
      for (const row of rows) {
        const state = JSON.parse(row.payload) as SupervisionState;
        for (const incident of state.incidents) {
          if (this.db.prepare("SELECT 1 FROM supervision_messages WHERE group_id=? AND incident_id=? LIMIT 1").get(state.groupId, incident.id)) continue;
          this.appendMessage(incidentMessage(state.group, incident, true));
        }
      }
    })();
  }
  listMessages(groupId: string, query: SupervisionMessageQuery = {}): SupervisionMessagePage {
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const incremental = query.afterSequence !== undefined;
    const condition = incremental ? "AND sequence>?" : query.beforeSequence !== undefined ? "AND sequence<?" : "";
    const params: Array<string | number> = [groupId];
    if (incremental) params.push(query.afterSequence!);
    else if (query.beforeSequence !== undefined) params.push(query.beforeSequence);
    params.push(limit + 1);
    const rows = this.db.prepare(`SELECT sequence,payload FROM supervision_messages WHERE group_id=? ${condition} ORDER BY sequence ${incremental ? "ASC" : "DESC"} LIMIT ?`).all(...params) as Array<{ sequence: number; payload: string }>;
    const page = rows.slice(0, limit);
    if (!incremental) page.reverse();
    return {
      messages: page.map(row => ({ ...JSON.parse(row.payload), sequence: row.sequence })),
      nextBefore: !incremental && rows.length > limit ? page[0].sequence : null,
      latestSequence: page.at(-1)?.sequence ?? query.afterSequence ?? 0,
    };
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
