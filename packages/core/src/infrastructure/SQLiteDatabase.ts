// ── SQLite Database ──
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export class SQLiteDatabase {
  readonly db: Database;

  constructor(baseDir: string) {
    const dataDir = join(baseDir, ".agent-data");
    try { mkdirSync(dataDir, { recursive: true }); } catch { /* exists */ }
    const dbPath = join(dataDir, "agent.db");
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'idle',
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        tool_calls TEXT NOT NULL DEFAULT '[]',
        tool_call_id TEXT,
        name TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        name TEXT PRIMARY KEY,
        description TEXT NOT NULL DEFAULT '',
        type TEXT NOT NULL DEFAULT 'user',
        content TEXT NOT NULL DEFAULT '',
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        command TEXT NOT NULL,
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        triggers TEXT NOT NULL DEFAULT '[]',
        prompt TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '0.1.0',
        path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS uploads (
        id TEXT PRIMARY KEY,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        error TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        context_placeholders TEXT NOT NULL DEFAULT '[]',
        capabilities TEXT NOT NULL DEFAULT '{"profileId":"","enabledTools":[],"enabledSkills":[],"enabledMCPServers":[]}',
        max_iterations INTEGER NOT NULL DEFAULT 0,
        is_default INTEGER NOT NULL DEFAULT 0,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );
    `);

    // Migration: make sessions.project_id nullable (remove NOT NULL + FK constraint)
    // SQLite requires recreating the table to change constraints.
    this.migrateSessionsProjectIdNullable();
    this.migrateMCPServerTransport();
  }

  /**
   * Recreate the sessions table so project_id is nullable with an optional FK.
   * Safe to run multiple times — checks if the column is already nullable first.
   */
  private migrateSessionsProjectIdNullable(): void {
    // Check if project_id column is still NOT NULL by inspecting table_info
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{
      name: string; notnull: number;
    }>;
    const col = cols.find((c) => c.name === "project_id");
    if (!col || col.notnull === 0) return; // already nullable, nothing to do

    this.db.transaction(() => {
      this.db.pragma("foreign_keys = OFF");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions_v2 (
          id TEXT PRIMARY KEY,
          project_id TEXT DEFAULT NULL
            REFERENCES projects(id) ON DELETE SET NULL,
          title TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'idle',
          created TEXT NOT NULL,
          updated TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}'
        );
        INSERT INTO sessions_v2
          SELECT id, NULLIF(project_id, ''), title, status, created, updated, metadata
          FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_v2 RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
      `);
      this.db.pragma("foreign_keys = ON");
    })();
  }

  /** Add transport and url columns to mcp_servers if they don't exist yet. */
  private migrateMCPServerTransport(): void {
    const cols = this.db.prepare("PRAGMA table_info(mcp_servers)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    if (!names.includes("transport")) {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN transport TEXT NOT NULL DEFAULT 'stdio'");
    }
    if (!names.includes("url")) {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN url TEXT");
    }
  }

  close(): void {
    this.db.close();
  }
}

// Singleton pattern - one DB per working directory
const instances = new Map<string, SQLiteDatabase>();
export function getDatabase(baseDir: string): SQLiteDatabase {
  let db = instances.get(baseDir);
  if (!db) {
    db = new SQLiteDatabase(baseDir);
    instances.set(baseDir, db);
  }
  return db;
}
