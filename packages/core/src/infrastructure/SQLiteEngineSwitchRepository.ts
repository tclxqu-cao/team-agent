import type { Database } from "better-sqlite3";
import type { AgentType } from "../domain/agent/agent-type.js";
import type {
  ContextHandoff,
  EngineSwitchRecord,
  EngineSwitchThread,
} from "../domain/engine-switch/entities.js";
import type { EngineSwitchRepository } from "../domain/engine-switch/EngineSwitchRepository.js";

// ── SQLite adapter for the engine-switch ports ──────────────────────────────
//
// Tables are created by SQLiteDatabase.migrate. This adapter only maps rows;
// it owns no business rules (those live in SwitchEngineUseCase and the renderer).

type Row = Record<string, unknown>;

const threadRowToEntity = (row: Row): EngineSwitchThread => ({
  threadKey: String(row.thread_key),
  currentSessionId: String(row.current_session_id),
  currentAgentType: row.current_agent_type as AgentType,
  created: String(row.created),
  updated: String(row.updated),
});

const recordRowToEntity = (row: Row): EngineSwitchRecord => ({
  id: String(row.id),
  threadKey: String(row.thread_key),
  fromSessionId: String(row.from_session),
  fromAgentType: String(row.from_agent_type) as AgentType,
  toSessionId: String(row.to_session),
  toAgentType: String(row.to_agent_type) as AgentType,
  strategy: row.strategy === "resume" ? "resume" : "create",
  handoffId: row.handoff_id == null ? null : String(row.handoff_id),
  coveredThroughHistoryId: row.covered_through_history == null ? null : String(row.covered_through_history),
  at: String(row.at),
  ...(row.source_snapshot == null ? {} : { sourceSnapshot: JSON.parse(String(row.source_snapshot)) }),
  ...(row.phase_messages == null ? {} : { phaseMessages: JSON.parse(String(row.phase_messages)) }),
  ...(row.source_history_count == null ? {} : { sourceHistoryItemCount: Number(row.source_history_count) }),
  ...(row.source_history_last_id == null ? {} : { sourceHistoryLastId: String(row.source_history_last_id) }),
});

const handoffRowToEntity = (row: Row): ContextHandoff => ({
  ...JSON.parse(String(row.payload || "{}")),
  id: String(row.id),
  threadKey: String(row.thread_key),
  fromSessionId: String(row.from_session),
  fromAgentType: String(row.from_agent_type) as AgentType,
  toSessionId: String(row.to_session),
  toAgentType: String(row.to_agent_type) as AgentType,
  strategy: row.strategy === "delta" ? "delta" : "full",
  summaryText: String(row.summary_text),
  omittedHistoryIds: JSON.parse(String(row.omitted_history || "[]")) as string[],
  status: row.status === "consumed" ? "consumed"
    : row.status === "failed" ? "failed"
      : row.status === "superseded" ? "superseded"
        : "pending",
  createdBy: row.created_by === "user" || row.created_by === "agent"
    ? (row.created_by as ContextHandoff["createdBy"])
    : "system",
  created: String(row.created),
  consumedAt: row.consumed_at == null ? null : String(row.consumed_at),
});

export class SQLiteEngineSwitchRepository implements EngineSwitchRepository {
  constructor(private readonly db: Database) {}

  /** Copy legacy server-owned ledgers once, without overwriting broker state. */
  importLegacy(legacy: SQLiteEngineSwitchRepository): void {
    this.db.transaction(() => {
      for (const thread of legacy.threads.list()) {
        if (this.threads.get(thread.threadKey)) continue;
        this.threads.ensure(thread);
        for (const record of legacy.records.list(thread.threadKey)) {
          this.records.append(record);
          const handoff = legacy.handoffs.byRecord(record.id);
          if (handoff) this.handoffs.insert(handoff);
        }
      }
    })();
  }

  acquire(threadKey: string, owner: string, expiresAt: number): boolean {
    return this.db.prepare(`INSERT INTO engine_switch_locks (thread_key, owner, expires_at) VALUES (?, ?, ?)
      ON CONFLICT(thread_key) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
      WHERE engine_switch_locks.expires_at < ?`).run(threadKey, owner, expiresAt, Date.now()).changes > 0;
  }

  release(threadKey: string, owner: string): void {
    this.db.prepare("DELETE FROM engine_switch_locks WHERE thread_key=? AND owner=?").run(threadKey, owner);
  }

  isLocked(threadKey: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM engine_switch_locks WHERE thread_key=? AND expires_at>=?")
      .get(threadKey, Date.now());
  }

  commit(input: Parameters<EngineSwitchRepository["commit"]>[0]): void {
    this.db.transaction(() => {
      const lock = this.db.prepare("SELECT owner, expires_at FROM engine_switch_locks WHERE thread_key=?")
        .get(input.thread.threadKey) as { owner: string; expires_at: number } | undefined;
      const current = this.threads.get(input.thread.threadKey);
      if (lock?.owner !== input.owner || lock.expires_at < Date.now()
        || (current?.currentSessionId ?? null) !== input.expectedSessionId) throw new Error("Thread changed while switching engines");
      this.threads.ensure(input.thread);
      this.records.append(input.record);
      this.handoffs.supersedePendingForThread(input.thread.threadKey, input.thread.updated);
      if (input.handoff) this.handoffs.insert(input.handoff);
    })();
  }

  readonly threads = {
    ensure: (thread: EngineSwitchThread): void => {
      this.db.prepare(`
        INSERT INTO engine_switch_threads (thread_key, current_session_id, current_agent_type, created, updated)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(thread_key) DO UPDATE SET
          current_session_id = excluded.current_session_id,
          current_agent_type = excluded.current_agent_type,
          updated = excluded.updated
      `).run(
        thread.threadKey,
        thread.currentSessionId,
        thread.currentAgentType,
        thread.created,
        thread.updated,
      );
    },
    get: (threadKey: string): EngineSwitchThread | null => {
      const row = this.db
        .prepare("SELECT * FROM engine_switch_threads WHERE thread_key = ?")
        .get(threadKey) as Row | undefined;
      return row ? threadRowToEntity(row) : null;
    },
    setSession: (threadKey: string, currentSessionId: string, currentAgentType: AgentType): void => {
      this.db.prepare(`
        UPDATE engine_switch_threads
        SET current_session_id = ?, current_agent_type = ?, updated = ?
        WHERE thread_key = ?
      `).run(currentSessionId, currentAgentType, new Date().toISOString(), threadKey);
    },
    list: (): EngineSwitchThread[] =>
      this.db
        .prepare("SELECT * FROM engine_switch_threads ORDER BY updated DESC")
        .all()
        .map((row) => threadRowToEntity(row as Row)),
  };

  readonly records = {
    append: (record: EngineSwitchRecord): void => {
      this.db.prepare(`
        INSERT INTO engine_switch_records
          (id, thread_key, from_session, from_agent_type, to_session, to_agent_type, strategy, handoff_id, covered_through_history, at, source_snapshot, phase_messages, source_history_count, source_history_last_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.threadKey,
        record.fromSessionId,
        record.fromAgentType,
        record.toSessionId,
        record.toAgentType,
        record.strategy,
        record.handoffId,
        record.coveredThroughHistoryId,
        record.at,
        record.sourceSnapshot ? JSON.stringify(record.sourceSnapshot) : null,
        record.phaseMessages ? JSON.stringify(record.phaseMessages) : null,
        record.sourceHistoryItemCount ?? null,
        record.sourceHistoryLastId ?? null,
      );
    },
    list: (threadKey: string, includeHistory = true): EngineSwitchRecord[] =>
      this.db
        .prepare(`SELECT ${includeHistory ? "*" : "id, thread_key, from_session, from_agent_type, to_session, to_agent_type, strategy, handoff_id, covered_through_history, at, source_history_count, source_history_last_id"}
          FROM engine_switch_records WHERE thread_key = ? ORDER BY rowid ASC`)
        .all(threadKey)
        .map((row) => recordRowToEntity(row as Row)),
    latestInvolving: (threadKey: string, agentType: AgentType): EngineSwitchRecord | null => {
      const row = this.db.prepare(`
        SELECT * FROM engine_switch_records
        WHERE thread_key = ? AND (to_agent_type = ? OR from_agent_type = ?)
        ORDER BY rowid DESC LIMIT 1
      `).get(threadKey, agentType, agentType) as Row | undefined;
      return row ? recordRowToEntity(row) : null;
    },
    latestFromTo: (fromSessionId: string, toAgentType: AgentType): EngineSwitchRecord | null => {
      const row = this.db.prepare(`
        SELECT * FROM engine_switch_records
        WHERE from_session = ? AND to_agent_type = ?
        ORDER BY rowid DESC LIMIT 1
      `).get(fromSessionId, toAgentType) as Row | undefined;
      return row ? recordRowToEntity(row) : null;
    },
    threadOfSession: (sessionId: string): string | null => {
      const row = this.db.prepare(`
        SELECT thread_key FROM engine_switch_records
        WHERE from_session = ? OR to_session = ?
        ORDER BY rowid DESC LIMIT 1
      `).get(sessionId, sessionId) as Row | undefined;
      return row ? String(row.thread_key) : null;
    },
  };

  readonly handoffs = {
    summariesForThread: (threadKey: string): Array<{ summaryText: string }> =>
      this.db.prepare("SELECT summary_text FROM context_handoffs WHERE thread_key = ?")
        .all(threadKey).map((row) => ({ summaryText: String((row as Row).summary_text) })),
    insert: (handoff: ContextHandoff): void => {
      this.db.prepare(`
        INSERT INTO context_handoffs
          (id, thread_key, from_session, from_agent_type, to_session, to_agent_type, strategy, summary_text, omitted_history, status, created_by, created, consumed_at, payload)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        handoff.id,
        handoff.threadKey,
        handoff.fromSessionId,
        handoff.fromAgentType,
        handoff.toSessionId,
        handoff.toAgentType,
        handoff.strategy,
        handoff.summaryText,
        JSON.stringify(handoff.omittedHistoryIds),
        handoff.status,
        handoff.createdBy,
        handoff.created,
        handoff.consumedAt,
        JSON.stringify({ historyFile: handoff.historyFile, includedHistoryIds: handoff.includedHistoryIds, images: handoff.images }),
      );
    },
    pendingForSession: (toSessionId: string): ContextHandoff | null => {
      const row = this.db.prepare(`
        SELECT * FROM context_handoffs
        WHERE to_session = ? AND status = 'pending'
        ORDER BY created ASC LIMIT 1
      `).get(toSessionId) as Row | undefined;
      return row ? handoffRowToEntity(row) : null;
    },
    markConsumed: (id: string, consumedAt: string): void => {
      this.db.prepare("UPDATE context_handoffs SET status = 'consumed', consumed_at = ? WHERE id = ? AND status = 'pending'")
        .run(consumedAt, id);
    },
    supersedePendingForThread: (threadKey: string, at: string): void => {
      this.db.prepare(`
        UPDATE context_handoffs SET status = 'superseded', consumed_at = ?
        WHERE thread_key = ? AND status = 'pending'
      `).run(at, threadKey);
    },
    byRecord: (recordId: string): ContextHandoff | null => {
      const row = this.db.prepare(`
        SELECT h.* FROM context_handoffs h
        JOIN engine_switch_records r ON r.handoff_id = h.id
        WHERE r.id = ?
      `).get(recordId) as Row | undefined;
      return row ? handoffRowToEntity(row) : null;
    },
  };
}
