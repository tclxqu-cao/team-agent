// ── SQLite Skill Store ──
import type { SkillDefinition } from '../domain/skill/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteSkillStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(name: string): Promise<SkillDefinition | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM skills WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSkill(row);
  }

  async save(skill: SkillDefinition): Promise<void> {
    const db = getDatabase(this.baseDir);
    const id = skill.name.toLowerCase().replace(/\s+/g, "-");
    db.db.prepare(
      "INSERT OR REPLACE INTO skills (id, name, description, triggers, prompt, enabled) VALUES (?,?,?,?,?,1)"
    ).run(
      id,
      skill.name,
      skill.description,
      JSON.stringify(skill.triggers),
      skill.prompt,
    );
  }

  async delete(name: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM skills WHERE name = ?").run(name);
  }

  async list(): Promise<SkillDefinition[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM skills WHERE enabled = 1 ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSkill(r));
  }

  async listAll(): Promise<SkillDefinition[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM skills ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToSkill(r));
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("UPDATE skills SET enabled = ? WHERE name = ?").run(enabled ? 1 : 0, name);
  }

  private rowToSkill(row: Record<string, unknown>): SkillDefinition {
    return {
      name: row.name as string,
      description: row.description as string,
      triggers: JSON.parse(row.triggers as string),
      prompt: row.prompt as string,
      filePath: "",
      source: "custom",
    };
  }
}
