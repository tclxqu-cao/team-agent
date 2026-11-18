import type Database from "better-sqlite3";
import type { ITodoUnitOfWork, TodoTables, TodoTransaction } from "../domain/todo/ports";
const tables: Array<keyof TodoTables> = ["todo_tasks", "todo_reminder_schedules", "todo_schedule_links", "todo_reminder_occurrences", "todo_execution_schedules", "todo_executions", "todo_execution_reports", "todo_command_receipts", "notifications", "notification_deliveries"];
export function migrateTodoTables(db: Database.Database): void {
  for (const table of tables) db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    ${table === "notifications" ? "sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE" : "id TEXT PRIMARY KEY"},
    owner_id TEXT NOT NULL, data TEXT NOT NULL, next_at INTEGER, dedupe_key TEXT,
    UNIQUE(owner_id, dedupe_key));
    CREATE INDEX IF NOT EXISTS ${table}_owner ON ${table}(owner_id);
    CREATE INDEX IF NOT EXISTS ${table}_next ON ${table}(next_at);`);
}
/** Each command and occurrence, including its receipt and notifications, commits
 * on one database handle. No session foreign keys: Todos outlive conversations. */
export class SQLiteTodoUnitOfWork implements ITodoUnitOfWork {
  private readonly repositories: TodoTransaction;
  constructor(private readonly db: Database.Database) {
    migrateTodoTables(db);
    this.repositories = Object.fromEntries(tables.map(table => {
      const decode = (row: { data: string; sequence?: number } | undefined) => row ? { ...JSON.parse(row.data), ...(row.sequence !== undefined ? { cursor: row.sequence } : {}) } : undefined;
      return [table, {
        get: (owner: string, id: string) => decode(db.prepare(`SELECT * FROM ${table} WHERE id=? AND owner_id=?`).get(id, owner) as { data: string } | undefined),
        list: (owner?: string) => (owner === undefined ? db.prepare(`SELECT * FROM ${table}`).all() : db.prepare(`SELECT * FROM ${table} WHERE owner_id=?`).all(owner)).map(row => decode(row as { data: string })),
        put: (record: { id: string; ownerId: string; nextFireAt?: number }, dedupeKey?: string) => { db.prepare(`INSERT INTO ${table}(id,owner_id,data,next_at,dedupe_key) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,next_at=excluded.next_at WHERE owner_id=excluded.owner_id`).run(record.id, record.ownerId, JSON.stringify(record), record.nextFireAt ?? null, dedupeKey ?? null); },
      }];
    })) as unknown as TodoTransaction;
  }
  run<T>(work: (tx: TodoTransaction) => T): T { return this.db.transaction(() => work(this.repositories)).immediate(); }
}
