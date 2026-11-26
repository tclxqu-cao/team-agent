import type Database from "better-sqlite3";
import type { TodoItem } from "../domain/agent/entities";
import { completedWorkTitles, TodoApplicationService } from "../application/todo";

type CompletionEvidence =
  | { kind: "session"; messageStart: number; eventStart: number; terminalEventId: number }
  | { kind: "native"; input: string; finalText: string; plan: TodoItem[] }
  | { kind: "reported"; titles: string[] };

interface CompletionJob {
  ownerId: string;
  sessionId: string;
  runId: string;
  startedAt: number;
  evidence: CompletionEvidence;
}

export function enqueueTodoCompletion(db: Database.Database, job: CompletionJob): void {
  db.prepare(`INSERT INTO todo_completion_jobs(owner_id,session_id,run_id,started_at,evidence)
    VALUES (?,?,?,?,?) ON CONFLICT(owner_id,session_id,run_id) DO NOTHING`)
    .run(job.ownerId, job.sessionId, job.runId, job.startedAt, JSON.stringify(job.evidence));
}

function readTitles(db: Database.Database, sessionId: string, runId: string, evidence: CompletionEvidence): string[] {
  if (evidence.kind === "reported") return evidence.titles;
  if (evidence.kind === "native") return completedWorkTitles(evidence.input, evidence.finalText, evidence.plan);
  const terminal = db.prepare("SELECT data FROM events WHERE id=? AND session_id=? AND type='done'")
    .get(evidence.terminalEventId, sessionId) as { data: string } | undefined;
  if (!terminal) return [];
  const done = JSON.parse(terminal.data);
  if (done.result?.runId !== runId || done.result.status !== "completed") return [];
  const message = db.prepare("SELECT role,content FROM messages WHERE session_id=? ORDER BY id LIMIT 1 OFFSET ?")
    .get(sessionId, evidence.messageStart) as { role: string; content: string } | undefined;
  const latest = db.prepare(`SELECT json_extract(data, '$.todos') AS todos FROM events
    WHERE session_id=? AND id<=? AND type='todo_update'
      AND id >= (SELECT id FROM events WHERE session_id=? ORDER BY id LIMIT 1 OFFSET ?)
    ORDER BY id DESC LIMIT 1`).get(sessionId, evidence.terminalEventId, sessionId, evidence.eventStart) as { todos: string } | undefined;
  return completedWorkTitles(message?.role === "user" ? message.content : "", done.finalText, latest ? JSON.parse(latest.todos) : []);
}

/** Called on the worker's own WAL connection. Use a read snapshot until the first write.
 * An interrupted transaction leaves the job ready for replay. */
export function processNextTodoCompletion(db: Database.Database, todos: TodoApplicationService, now = Date.now()): boolean {
  let job: Pick<CompletionJob, "ownerId" | "sessionId" | "runId"> | undefined;
  try {
    return db.transaction(() => {
      const row = db.prepare(`SELECT rowid AS id, owner_id AS ownerId, session_id AS sessionId, run_id AS runId,
        started_at AS startedAt, evidence FROM todo_completion_jobs WHERE retry_at<=? ORDER BY retry_at,rowid LIMIT 1`)
        .get(now) as (Omit<CompletionJob, "evidence"> & { id: number; evidence: string }) | undefined;
      if (!row) return false;
      job = row;
      const titles = readTitles(db, row.sessionId, row.runId, JSON.parse(row.evidence));
      todos.completeReportedWork(titles, row.startedAt, row);
      db.prepare("DELETE FROM todo_completion_jobs WHERE rowid=?").run(row.id);
      return true;
    }).deferred();
  } catch (error) {
    if (job) {
      db.prepare("UPDATE todo_completion_jobs SET retry_at=? WHERE owner_id=? AND session_id=? AND run_id=?")
        .run(now + 5000, job.ownerId, job.sessionId, job.runId);
    }
    throw error;
  }
}
