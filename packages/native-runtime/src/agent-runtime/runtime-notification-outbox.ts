import type Database from "better-sqlite3";
import type { AgentEvent } from "@agent/core";
import type { RuntimeTodoContext } from "./runtime-tool-injection";
import { TodoServiceClient } from "../todo-mcp/todo-service-client";
/** This database is the Broker's, not the service's. Delivery is at-least-once,
 * and the destination service persists the stable source event before ACK. */
export class RuntimeNotificationOutbox {
  private flushing = false;
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS native_runtime_todo_context(session_id TEXT PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_runtime_completion_plan(run_id TEXT PRIMARY KEY, todos TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_runtime_notification_outbox(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,payload TEXT NOT NULL,destination TEXT NOT NULL,created_at INTEGER NOT NULL);`);
    this.timer = setInterval(() => { void this.flush().catch(() => undefined); }, 3000); this.timer.unref();
  }
  get(sessionId: string): RuntimeTodoContext | undefined {
    const row = this.db.prepare("SELECT data FROM native_runtime_todo_context WHERE session_id=?").get(sessionId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }
  sessionForExecution(context: RuntimeTodoContext): string | undefined {
    if (!context.executionId) return;
    return (this.db.prepare("SELECT session_id FROM native_runtime_todo_context WHERE json_extract(data,'$.serviceId')=? AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.executionId')=? LIMIT 1").get(context.serviceId, context.ownerId, context.executionId) as { session_id: string } | undefined)?.session_id;
  }
  set(sessionId: string, context: RuntimeTodoContext): void {
    const old = this.get(sessionId);
    if (old && (old.serviceId !== context.serviceId || old.ownerId !== context.ownerId || old.executionId !== context.executionId)) throw new Error("Native session is already bound to another Todo scope");
    this.db.prepare("INSERT INTO native_runtime_todo_context(session_id,data) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET data=excluded.data").run(sessionId, JSON.stringify(context));
  }
  append(sessionId: string, runId: string, sequence: number, event: AgentEvent, createdAt: number, resolveDestination: () => RuntimeTodoContext | undefined, run?: { input: string; createdAt: number }): void {
    if (event.type === "todo_update") {
      const dest = resolveDestination();
      if (dest?.relayPath && !dest.executionId) {
        this.db.prepare(`INSERT INTO native_runtime_completion_plan(run_id,todos) VALUES(?,?)
          ON CONFLICT(run_id) DO UPDATE SET todos=excluded.todos`).run(runId, JSON.stringify(event.todos));
      }
      return;
    }
    if (!["ask_user", "approval_resolved", "done", "error", "turn_aborted"].includes(event.type)) return;
    const destination = resolveDestination();
    if (!destination?.relayPath) return;
    const completionSource = run && !destination.executionId && event.type === "done" && event.result?.status === "completed"
      ? { input: run.input, startedAt: run.createdAt } : undefined;
    this.db.prepare("INSERT OR IGNORE INTO native_runtime_notification_outbox(id,session_id,payload,destination,created_at) VALUES(?,?,?,?,?)")
      .run(`${runId}:${sequence}`, sessionId, JSON.stringify({ runId, event, createdAt, completionSource }), JSON.stringify(destination), createdAt);
  }
  async bindRun(context: RuntimeTodoContext, runId: string): Promise<void> {
    if (context.executionId && context.relayPath) {
      await new TodoServiceClient({ serviceId: context.serviceId, descriptorPath: context.relayPath, registry: context.discoveryDirectory }).call("bind_execution", { runId });
    }
  }
  async flush(): Promise<void> {
    if (this.flushing || this.closed) return; this.flushing = true;
    try {
      const rows = this.db.prepare("SELECT * FROM native_runtime_notification_outbox ORDER BY created_at,rowid LIMIT 100").all() as Array<{ id: string; payload: string; destination: string }>;
      const failed = new Set<string>();
      for (const row of rows) {
        const c = JSON.parse(row.destination) as RuntimeTodoContext;
        if (failed.has(c.serviceId)) continue;
        try {
          const payload = JSON.parse(row.payload);
          if (payload.completionSource) {
            const plan = this.db.prepare("SELECT todos FROM native_runtime_completion_plan WHERE run_id=?")
              .get(payload.runId) as { todos: string } | undefined;
            payload.completionSource.plan = plan ? JSON.parse(plan.todos) : [];
          }
          await new TodoServiceClient({ serviceId: c.serviceId, descriptorPath: c.relayPath!, registry: c.discoveryDirectory })
            .call("runtime_event", payload);
          if (!this.closed) this.db.transaction(() => {
            this.db.prepare("DELETE FROM native_runtime_notification_outbox WHERE id=?").run(row.id);
            if (["done", "error", "turn_aborted"].includes(payload.event.type)) {
              this.db.prepare("DELETE FROM native_runtime_completion_plan WHERE run_id=?").run(payload.runId);
            }
          })();
        } catch { failed.add(c.serviceId); }
      }
    } finally { this.flushing = false; }
  }
  close(): void { this.closed = true; clearInterval(this.timer); }
}
