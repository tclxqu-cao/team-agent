import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
export function persistentServiceId(baseDir) {
  mkdirSync(join(baseDir, ".agent-data"), { recursive: true });
  const db = new Database(join(baseDir, ".agent-data", "agent.db"));
  try {
    db.pragma("busy_timeout = 5000");
    db.exec("CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
    return db.transaction(() => {
      const row = db.prepare("SELECT value FROM settings WHERE key='todo.serviceId'").get();
      if (row) return JSON.parse(row.value);
      const id = randomUUID(); db.prepare("INSERT INTO settings(key,value) VALUES('todo.serviceId',?)").run(JSON.stringify(id)); return id;
    }).immediate();
  } finally { db.close(); }
}
