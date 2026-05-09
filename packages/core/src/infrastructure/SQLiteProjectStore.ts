// ── SQLite Project Store ──
import type { IProjectStore, Project } from '../domain/project/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteProjectStore implements IProjectStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(id: string): Promise<Project | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToProject(row);
  }

  async create(project: Project): Promise<Project> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      "INSERT INTO projects (id, name, description, created, updated) VALUES (?, ?, ?, ?, ?)"
    ).run(project.id, project.name, project.description, project.created, project.updated);
    return project;
  }

  async update(id: string, update: Partial<Project>): Promise<Project> {
    const db = getDatabase(this.baseDir);
    const existing = await this.get(id);
    if (!existing) throw new Error(`Project not found: ${id}`);
    const merged = { ...existing, ...update, updated: new Date().toISOString() };
    db.db.prepare("UPDATE projects SET name=?, description=?, updated=? WHERE id=?")
      .run(merged.name, merged.description, merged.updated, id);
    return merged;
  }

  async delete(id: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    // cascade: sessions get their project_id set to '' (disowned, not deleted)
    db.db.prepare("UPDATE sessions SET project_id = '' WHERE project_id = ?").run(id);
    db.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  async list(): Promise<Project[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM projects ORDER BY updated DESC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToProject(r));
  }

  private rowToProject(row: Record<string, unknown>): Project {
    return {
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      created: row.created as string,
      updated: row.updated as string,
    };
  }
}
