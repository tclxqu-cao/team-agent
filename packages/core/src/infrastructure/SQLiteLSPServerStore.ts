// ── SQLite LSP Server Store ──
import type { ILSPServerStore, LSPServerConfig } from '../domain/lsp/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteLSPServerStore implements ILSPServerStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(id: string): Promise<LSPServerConfig | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare('SELECT * FROM lsp_servers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToConfig(row) : null;
  }

  async save(config: LSPServerConfig): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      `INSERT OR REPLACE INTO lsp_servers
        (id, name, language, file_types, command, args, env, enabled)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(
      config.id,
      config.name,
      config.language,
      JSON.stringify(config.fileTypes ?? []),
      config.command,
      JSON.stringify(config.args ?? []),
      JSON.stringify(config.env ?? {}),
      config.enabled ? 1 : 0,
    );
  }

  async delete(id: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare('DELETE FROM lsp_servers WHERE id = ?').run(id);
  }

  /** Only enabled servers */
  async list(): Promise<LSPServerConfig[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare('SELECT * FROM lsp_servers WHERE enabled = 1 ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToConfig(r));
  }

  /** All servers including disabled */
  async listAll(): Promise<LSPServerConfig[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare('SELECT * FROM lsp_servers ORDER BY name ASC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToConfig(r));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare('UPDATE lsp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  private rowToConfig(row: Record<string, unknown>): LSPServerConfig {
    return {
      id: row.id as string,
      name: row.name as string,
      language: row.language as string,
      fileTypes: JSON.parse((row.file_types as string) ?? '[]'),
      command: row.command as string,
      args: JSON.parse((row.args as string) ?? '[]'),
      env: JSON.parse((row.env as string) ?? '{}'),
      enabled: (row.enabled as number) === 1,
    };
  }
}
