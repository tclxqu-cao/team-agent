// ── SQLite MCP Server Store ──
import type { MCPServerConfig } from '../domain/mcp/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteMCPServerStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(id: string): Promise<MCPServerConfig | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToConfig(row);
  }

  async save(config: MCPServerConfig): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      "INSERT OR REPLACE INTO mcp_servers (id, name, command, args, env, enabled) VALUES (?,?,?,?,?,1)"
    ).run(
      config.id,
      config.name,
      config.command,
      JSON.stringify(config.args),
      JSON.stringify(config.env ?? {}),
    );
  }

  async delete(id: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  }

  async list(): Promise<MCPServerConfig[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM mcp_servers ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.filter((r) => r.enabled as number === 1).map((r) => this.rowToConfig(r));
  }

  async listAll(): Promise<MCPServerConfig[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM mcp_servers ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToConfig(r));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  private rowToConfig(row: Record<string, unknown>): MCPServerConfig {
    return {
      id: row.id as string,
      name: row.name as string,
      command: row.command as string,
      args: JSON.parse(row.args as string),
      env: JSON.parse(row.env as string),
      transport: "stdio" as const,
    };
  }
}
