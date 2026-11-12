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
});

const handoffRowToEntity = (row: Row): ContextHandoff => ({
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
  };

  readonly records = {
    append: (record: EngineSwitchRecord): void => {
      this.db.prepare(`
        INSERT INTO engine_switch_records
          (id, thread_key, from_session, from_agent_type, to_session, to_agent_type, strategy, handoff_id, covered_through_history, at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      );
    },
    list: (threadKey: string): EngineSwitchRecord[] =>
      this.db
        .prepare("SELECT * FROM engine_switch_records WHERE thread_key = ? ORDER BY at ASC")
        .all(threadKey)
        .map((row) => recordRowToEntity(row as Row)),
    latestInvolving: (threadKey: string, agentType: AgentType): EngineSwitchRecord | null => {
      const row = this.db.prepare(`
        SELECT * FROM engine_switch_records
        WHERE thread_key = ? AND (to_agent_type = ? OR from_agent_type = ?)
        ORDER BY at DESC LIMIT 1
      `).get(threadKey, agentType, agentType) as Row | undefined;
      return row ? recordRowToEntity(row) : null;
    },
    latestFromTo: (fromSessionId: string, toAgentType: AgentType): EngineSwitchRecord | null => {
      const row = this.db.prepare(`
        SELECT * FROM engine_switch_records
        WHERE from_session = ? AND to_agent_type = ?
        ORDER BY at DESC LIMIT 1
      `).get(fromSessionId, toAgentType) as Row | undefined;
      return row ? recordRowToEntity(row) : null;
    },
    threadOfSession: (sessionId: string): string | null => {
      const row = this.db.prepare(`
        SELECT thread_key FROM engine_switch_records
        WHERE from_session = ? OR to_session = ?
        ORDER BY at DESC LIMIT 1
      `).get(sessionId, sessionId) as Row | undefined;
      return row ? String(row.thread_key) : null;
    },
  };

  readonly handoffs = {
    insert: (handoff: ContextHandoff): void => {
      this.db.prepare(`
        INSERT INTO context_handoffs
          (id, thread_key, from_session, from_agent_type, to_session, to_agent_type, strategy, summary_text, omitted_history, status, created_by, created, consumed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      this.db.prepare("UPDATE context_handoffs SET status = 'consumed', consumed_at = ? WHERE id = ?")
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
