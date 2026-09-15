import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

export class SQLiteDatabase {
  readonly db: Database;

  constructor(baseDir: string) {
    const dataDir = join(baseDir, ".agent-data");
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "agent.db"));
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
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
        presentation TEXT,
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}',
        timestamp INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS thread_goals (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        objective TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds REAL NOT NULL DEFAULT 0,
        turn_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS lsp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT '',
        file_types TEXT NOT NULL DEFAULT '[]',
        command TEXT NOT NULL DEFAULT '',
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS remote_tools (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scheme TEXT NOT NULL,
        purpose TEXT NOT NULL,
        url TEXT NOT NULL,
        method TEXT NOT NULL DEFAULT 'POST',
        headers TEXT NOT NULL DEFAULT '{}',
        input_schema TEXT NOT NULL DEFAULT '{}',
        output_schema TEXT NOT NULL DEFAULT '{}',
        examples TEXT NOT NULL DEFAULT '[]',
        auth TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1,
        created TEXT NOT NULL,
        updated TEXT NOT NULL,
        UNIQUE(project_id, scheme)
      );

      CREATE TABLE IF NOT EXISTS remote_tool_jobs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        scheme TEXT NOT NULL,
        request_payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        response_payload TEXT,
        error TEXT,
        created TEXT NOT NULL,
        updated TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username_normalized TEXT UNIQUE NOT NULL,
        username_display TEXT NOT NULL,
        password_hash BLOB NOT NULL,
        password_salt BLOB NOT NULL,
        password_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        password_changed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash BLOB UNIQUE NOT NULL,
        csrf_hash BLOB NOT NULL,
        ws_nonce_hash BLOB,
        ws_nonce_expires_at TEXT,
        device_id TEXT NOT NULL,
        device_name TEXT,
        user_agent TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS anonymous_ws_nonces (
        nonce_hash BLOB PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS login_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username_normalized TEXT NOT NULL,
        ip TEXT NOT NULL,
        attempted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS terminal_tabs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        shell TEXT NOT NULL,
        start_cwd TEXT NOT NULL,
        current_cwd TEXT NOT NULL,
        status TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        exited_at TEXT,
        closed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL DEFAULT 1,
        theme TEXT NOT NULL DEFAULT 'dark',
        terminal_font_size INTEGER NOT NULL DEFAULT 11,
        file_button_position_json TEXT NOT NULL DEFAULT '{"xRatio":0.94,"yRatio":0.65,"anchor":"right"}',
        keybar_position_json TEXT NOT NULL DEFAULT '{"xRatio":0.5,"yRatio":0.95,"anchor":"bottom"}',
        keybar_hidden INTEGER NOT NULL DEFAULT 0,
        key_order_json TEXT NOT NULL DEFAULT '[]',
        pinned_commands_json TEXT DEFAULT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS device_states (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id TEXT NOT NULL,
        active_terminal_id TEXT,
        drawer_open INTEGER NOT NULL DEFAULT 0,
        drawer_tab TEXT NOT NULL DEFAULT 'files',
        file_tree_root TEXT,
        file_tree_follow_mode INTEGER NOT NULL DEFAULT 1,
        expanded_paths_json TEXT NOT NULL DEFAULT '[]',
        selected_file TEXT,
        terminal_scroll_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (user_id, device_id)
      );

      CREATE TABLE IF NOT EXISTS command_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        terminal_id TEXT NOT NULL,
        command TEXT NOT NULL,
        command_normalized TEXT NOT NULL,
        cwd TEXT NOT NULL,
        executed_at TEXT NOT NULL,
        exit_code INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_remote_tools_project ON remote_tools(project_id);
      CREATE INDEX IF NOT EXISTS idx_remote_jobs_project ON remote_tool_jobs(project_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_anonymous_ws_nonces_expiry ON anonymous_ws_nonces(expires_at);
      CREATE INDEX IF NOT EXISTS idx_login_attempts_lookup
        ON login_attempts(username_normalized, ip, attempted_at);
      CREATE INDEX IF NOT EXISTS idx_terminal_tabs_user_order ON terminal_tabs(user_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_command_history_user_time ON command_history(user_id, executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_command_history_terminal_time ON command_history(user_id, terminal_id, executed_at DESC);
    `);

    // Migration: make sessions.project_id nullable (remove NOT NULL + FK constraint)
    // SQLite requires recreating the table to change constraints.
    this.migrateSessionsProjectIdNullable();
    this.migrateMCPServerTransport();
    this.migrateMCPServerCommandNullable();
    this.migrateMCPServerHeaders();
    this.migrateSessionsParentId();
    this.migrateMessagePresentation();
    this.migrateLSPServers();
    this.migratePinnedCommands();
    this.migrateCommandHistoryExitCode();
  }

  /** exit_code arrived after the first command_history release; NULL = captured before exit codes existed. */
  private migrateCommandHistoryExitCode(): void {
    const cols = this.db.prepare("PRAGMA table_info(command_history)").all() as Array<{ name: string }>;
    if (!cols.some((column) => column.name === "exit_code")) {
      this.db.exec("ALTER TABLE command_history ADD COLUMN exit_code INTEGER");
    }
  }

  private migratePinnedCommands(): void {
    const cols = this.db.prepare("PRAGMA table_info(user_preferences)").all() as Array<{ name: string }>;
    if (!cols.some((column) => column.name === "pinned_commands_json")) {
      this.db.exec("ALTER TABLE user_preferences ADD COLUMN pinned_commands_json TEXT DEFAULT NULL");
    }
  }

  /** Create lsp_servers table if it doesn't exist (for DBs created before this feature). */
  private migrateLSPServers(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lsp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT '',
        file_types TEXT NOT NULL DEFAULT '[]',
        command TEXT NOT NULL DEFAULT '',
        args TEXT NOT NULL DEFAULT '[]',
        env TEXT NOT NULL DEFAULT '{}',
        enabled INTEGER NOT NULL DEFAULT 1
      );
    `);
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

  /** Recreate mcp_servers so command/args/env allow NULL (needed for SSE remote servers). */
  private migrateMCPServerCommandNullable(): void {
    const cols = this.db.prepare("PRAGMA table_info(mcp_servers)").all() as Array<{ name: string; notnull: number }>;
    const commandCol = cols.find((c) => c.name === "command");
    if (!commandCol || commandCol.notnull === 0) return; // already nullable

    this.db.transaction(() => {
      this.db.pragma("foreign_keys = OFF");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS mcp_servers_v2 (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          transport TEXT NOT NULL DEFAULT 'stdio',
          command TEXT,
          args TEXT NOT NULL DEFAULT '[]',
          env TEXT NOT NULL DEFAULT '{}',
          url TEXT,
          enabled INTEGER NOT NULL DEFAULT 1
        );
        INSERT INTO mcp_servers_v2 (id, name, transport, command, args, env, url, enabled)
          SELECT id, name,
            COALESCE(transport, 'stdio'),
            NULLIF(command, ''),
            COALESCE(args, '[]'),
            COALESCE(env, '{}'),
            url,
            enabled
          FROM mcp_servers;
        DROP TABLE mcp_servers;
        ALTER TABLE mcp_servers_v2 RENAME TO mcp_servers;
      `);
      this.db.pragma("foreign_keys = ON");
    })();
  }

  /** Add headers column to mcp_servers if missing. */
  private migrateMCPServerHeaders(): void {
    const cols = this.db.prepare("PRAGMA table_info(mcp_servers)").all() as Array<{ name: string }>;
    if (!cols.find((c) => c.name === "headers")) {
      this.db.exec("ALTER TABLE mcp_servers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}'");
    }
  }

  /** Add parent_id column to sessions for sub-session support. */
  private migrateSessionsParentId(): void {
    const cols = this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    if (!cols.find((c) => c.name === "parent_id")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN parent_id TEXT REFERENCES sessions(id) ON DELETE CASCADE");
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_id)");
    }
  }

  /** Add display-only message metadata without changing semantic history fields. */
  private migrateMessagePresentation(): void {
    const cols = this.db.prepare("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
    if (!cols.some((column) => column.name === "presentation")) {
      this.db.exec("ALTER TABLE messages ADD COLUMN presentation TEXT");
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
