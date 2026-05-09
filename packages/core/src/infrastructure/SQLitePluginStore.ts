// ── SQLite Plugin Store ──
import type { PluginManifest } from '../domain/plugin/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLitePluginStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(name: string): Promise<PluginManifest | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM plugins WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToManifest(row);
  }

  async save(manifest: PluginManifest): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      "INSERT OR REPLACE INTO plugins (id, name, version, path, enabled) VALUES (?,?,?,?,1)"
    ).run(
      manifest.name.toLowerCase().replace(/\s+/g, "-"),
      manifest.name,
      manifest.version,
      manifest.main,
    );
  }

  async delete(name: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM plugins WHERE name = ?").run(name);
  }

  async list(): Promise<{ name: string; version: string; manifest: PluginManifest }[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM plugins WHERE enabled = 1 ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: r.name as string,
      version: r.version as string,
      manifest: this.rowToManifest(r),
    }));
  }

  async listAll(): Promise<{ name: string; version: string; manifest: PluginManifest }[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM plugins ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      name: r.name as string,
      version: r.version as string,
      manifest: this.rowToManifest(r),
    }));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("UPDATE plugins SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name);
  }

  private rowToManifest(row: Record<string, unknown>): PluginManifest {
    return {
      name: row.name as string,
      version: row.version as string,
      description: "",
      permissions: {},
      main: row.path as string,
    };
  }
}
