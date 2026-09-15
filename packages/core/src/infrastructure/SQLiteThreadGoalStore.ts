// ── SQLite Thread Goal Store ──
// 每个会话一行目标记录（thread_goals.session_id 主键），随会话级联删除。
import type { IThreadGoalStore, ThreadGoal } from '../domain/goal/ThreadGoal.js';
import { isThreadGoalStatus } from '../domain/goal/ThreadGoal.js';
import { getDatabase } from './SQLiteDatabase.js';

interface ThreadGoalRow {
  session_id: string;
  objective: string;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  turn_count: number;
  created_at: string;
  updated_at: string;
}

function rowToGoal(row: ThreadGoalRow): ThreadGoal {
  return {
    sessionId: row.session_id,
    objective: row.objective,
    status: isThreadGoalStatus(row.status) ? row.status : "active",
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    turnCount: row.turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SQLiteThreadGoalStore implements IThreadGoalStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(sessionId: string): Promise<ThreadGoal | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM thread_goals WHERE session_id = ?").get(sessionId) as ThreadGoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  async set(goal: ThreadGoal): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(`
      INSERT INTO thread_goals (session_id, objective, status, token_budget, tokens_used, time_used_seconds, turn_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        objective = excluded.objective,
        status = excluded.status,
        token_budget = excluded.token_budget,
        tokens_used = excluded.tokens_used,
        time_used_seconds = excluded.time_used_seconds,
        turn_count = excluded.turn_count,
        updated_at = excluded.updated_at
    `).run(
      goal.sessionId,
      goal.objective,
      goal.status,
      goal.tokenBudget,
      goal.tokensUsed,
      goal.timeUsedSeconds,
      goal.turnCount,
      goal.createdAt,
      goal.updatedAt,
    );
    // 目标变更属于会话活动：bump sessions.updated 让 session-changes SSE 推送刷新。
    db.db.prepare("UPDATE sessions SET updated = ? WHERE id = ?").run(new Date().toISOString(), goal.sessionId);
  }

  async clear(sessionId: string): Promise<boolean> {
    const db = getDatabase(this.baseDir);
    const result = db.db.prepare("DELETE FROM thread_goals WHERE session_id = ?").run(sessionId);
    if (result.changes > 0) {
      db.db.prepare("UPDATE sessions SET updated = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
    }
    return result.changes > 0;
  }

  async listActive(): Promise<ThreadGoal[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM thread_goals WHERE status = 'active'").all() as ThreadGoalRow[];
    return rows.map(rowToGoal);
  }
}
