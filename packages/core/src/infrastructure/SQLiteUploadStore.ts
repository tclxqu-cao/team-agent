// ── SQLite Upload Store ──
import type { IUploadStore, UploadEntry, UploadStatus } from '../domain/upload/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteUploadStore implements IUploadStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(id: string): Promise<UploadEntry | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM uploads WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  async save(entry: UploadEntry): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      `INSERT OR REPLACE INTO uploads (id, file_name, file_path, mime_type, size, status, error, metadata, created, updated)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      entry.id,
      entry.fileName,
      entry.filePath,
      entry.mimeType,
      entry.size,
      entry.status,
      entry.error ?? null,
      JSON.stringify(entry.metadata ?? {}),
      entry.created,
      entry.updated,
    );
  }

  async delete(id: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM uploads WHERE id = ?").run(id);
  }

  async list(): Promise<UploadEntry[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM uploads ORDER BY created DESC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEntry(r));
  }

  async updateStatus(id: string, status: UploadStatus, error?: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    const now = new Date().toISOString();
    db.db.prepare(
      "UPDATE uploads SET status = ?, error = ?, updated = ? WHERE id = ?"
    ).run(status, error ?? null, now, id);
  }

  private rowToEntry(row: Record<string, unknown>): UploadEntry {
    return {
      id: row.id as string,
      fileName: row.file_name as string,
      filePath: row.file_path as string,
      mimeType: row.mime_type as string,
      size: row.size as number,
      status: row.status as UploadStatus,
      error: (row.error as string) ?? undefined,
      metadata: JSON.parse(row.metadata as string),
      created: row.created as string,
      updated: row.updated as string,
    };
  }
}
