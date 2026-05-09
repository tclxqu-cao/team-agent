// ── SQLite Memory Store ──
import type { IMemoryStore, MemoryEntry, MemorySearchResult } from '../domain/memory/entities.js';
import { getDatabase } from './SQLiteDatabase.js';

export class SQLiteMemoryStore implements IMemoryStore {
  private readonly baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    getDatabase(baseDir);
  }

  async get(name: string): Promise<MemoryEntry | null> {
    const db = getDatabase(this.baseDir);
    const row = db.db.prepare("SELECT * FROM memories WHERE name = ?").get(name) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToEntry(row);
  }

  async set(entry: MemoryEntry): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare(
      "INSERT OR REPLACE INTO memories (name, description, type, content, created, updated) VALUES (?,?,?,?,?,?)"
    ).run(entry.name, entry.description, entry.type, entry.content, entry.created, entry.updated);
  }

  async delete(name: string): Promise<void> {
    const db = getDatabase(this.baseDir);
    db.db.prepare("DELETE FROM memories WHERE name = ?").run(name);
  }

  async list(): Promise<MemoryEntry[]> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT * FROM memories ORDER BY name ASC").all() as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToEntry(r));
  }

  async search(query: string): Promise<MemorySearchResult[]> {
    const all = await this.list();
    const lowerQuery = query.toLowerCase();
    const results: MemorySearchResult[] = [];

    for (const entry of all) {
      const contentLower = entry.content.toLowerCase();
      const descLower = entry.description.toLowerCase();
      const nameLower = entry.name.toLowerCase();

      const queryWords = lowerQuery.split(/\s+/).filter((w) => w.length > 1);

      let score = 0;
      for (const word of queryWords) {
        if (nameLower.includes(word)) score += 10;
        if (descLower.includes(word)) score += 5;
        if (contentLower.includes(word)) score += 3;
      }

      if (score > 0) {
        const idx = contentLower.indexOf(queryWords[0] ?? lowerQuery);
        const start = Math.max(0, idx - 40);
        const end = Math.min(entry.content.length, idx + lowerQuery.length + 40);
        const snippet = (start > 0 ? "..." : "") + entry.content.slice(start, end) + (end < entry.content.length ? "..." : "");

        results.push({ entry, score, snippet });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  async generateContext(query: string, maxTokens = 2000): Promise<string> {
    const results = await this.search(query);
    if (results.length === 0) return "";

    const topResults = results.filter((r) => r.score >= 5).slice(0, 5);
    if (topResults.length === 0) return "";

    const parts: string[] = [];
    let charCount = 0;
    const charBudget = maxTokens * 4;

    for (const r of topResults) {
      const text = `[${r.entry.type}] ${r.entry.name}: ${r.entry.description}\n${r.entry.content}`;
      if (charCount + text.length > charBudget) break;
      parts.push(text);
      charCount += text.length;
    }

    return parts.join("\n\n");
  }

  async getIndex(): Promise<string> {
    const db = getDatabase(this.baseDir);
    const rows = db.db.prepare("SELECT name, description FROM memories ORDER BY name ASC").all() as Array<{ name: string; description: string }>;
    if (rows.length === 0) return "";
    return rows.map((r) => `- [${r.name}] — ${r.description}`).join("\n");
  }

  private rowToEntry(row: Record<string, unknown>): MemoryEntry {
    return {
      name: row.name as string,
      description: row.description as string,
      type: row.type as MemoryEntry["type"],
      content: row.content as string,
      created: row.created as string,
      updated: row.updated as string,
    };
  }
}
