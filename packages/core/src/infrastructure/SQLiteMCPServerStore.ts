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
      "INSERT OR REPLACE INTO mcp_servers (id, name, transport, command, args, env, url, headers, enabled) VALUES (?,?,?,?,?,?,?,?,1)"
    ).run(
      config.id,
      config.name,
      config.transport ?? "stdio",
      config.command ?? "",
      JSON.stringify(config.args ?? []),
      JSON.stringify(config.env ?? {}),
      config.url ?? config.sseUrl ?? null,
      JSON.stringify(config.headers ?? {}),
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

  private rowToConfig(row: Record<string, unknown>): MCPServerConfig & { enabled: boolean } {
    const transport = (row.transport as string ?? "stdio") as "stdio" | "sse" | "streamableHttp";
    return {
      id: row.id as string,
      enabled: Number(row.enabled) === 1,
      name: row.name as string,
      transport,
      command: row.command as string || undefined,
      args: JSON.parse(row.args as string ?? "[]"),
      env: JSON.parse(row.env as string ?? "{}"),
      url: (row.url as string) || undefined,
      headers: JSON.parse(row.headers as string ?? "{}"),
    };
  }
}
