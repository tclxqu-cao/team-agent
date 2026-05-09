import type { IMemoryStore, MemoryEntry, MemorySearchResult } from './entities.js';
import { readFile, writeFile, readdir, unlink, mkdir, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";

const MEMORY_INDEX = "MEMORY.md";

export class FileSystemMemoryStore implements IMemoryStore {
  private readonly memoryDir: string;

  constructor(baseDir: string) {
    this.memoryDir = join(baseDir, "memory");
  }

  private async ensureDir(): Promise<void> {
    try {
      await mkdir(this.memoryDir, { recursive: true });
    } catch {
      // already exists
    }
  }

  async get(name: string): Promise<MemoryEntry | null> {
    const filePath = join(this.memoryDir, `${name}.md`);
    try {
      const content = await readFile(filePath, "utf-8");
      return this.parseMemoryFile(name, content);
    } catch {
      return null;
    }
  }

  async set(entry: MemoryEntry): Promise<void> {
    await this.ensureDir();
    const filePath = join(this.memoryDir, `${entry.name}.md`);
    const content = this.formatMemoryFile(entry);
    await writeFile(filePath, content, "utf-8");
    await this.updateIndex(entry);
  }

  async delete(name: string): Promise<void> {
    const filePath = join(this.memoryDir, `${name}.md`);
    try {
      await unlink(filePath);
    } catch {
      // file doesn't exist
    }
    await this.removeFromIndex(name);
  }

  async list(): Promise<MemoryEntry[]> {
    await this.ensureDir();
    const entries: MemoryEntry[] = [];

    try {
      const files = await readdir(this.memoryDir);
      for (const file of files) {
        if (file === MEMORY_INDEX || !file.endsWith(".md")) continue;
        const name = basename(file, ".md");
        const entry = await this.get(name);
        if (entry) entries.push(entry);
      }
    } catch {
      // directory doesn't exist
    }

    return entries;
  }

  async search(query: string): Promise<MemorySearchResult[]> {
    const all = await this.list();
    const lowerQuery = query.toLowerCase();
    const results: MemorySearchResult[] = [];

    for (const entry of all) {
      const contentLower = entry.content.toLowerCase();
      const descLower = entry.description.toLowerCase();
      const nameLower = entry.name.toLowerCase();

      // Tokenize query into words and match individually
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
    const indexPath = join(this.memoryDir, MEMORY_INDEX);
    try {
      return await readFile(indexPath, "utf-8");
    } catch {
      return "";
    }
  }

  private parseMemoryFile(name: string, content: string): MemoryEntry {
    const lines = content.split("\n");
    let description = "";
    let type: MemoryEntry["type"] = "user";
    let memoryContent = content;

    // Parse frontmatter
    if (lines[0]?.trim() === "---") {
      let i = 1;
      const fmLines: string[] = [];
      for (; i < lines.length; i++) {
        if (lines[i].trim() === "---") break;
        fmLines.push(lines[i]);
      }

      for (const line of fmLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const key = line.slice(0, colonIdx).trim().toLowerCase();
        const value = line.slice(colonIdx + 1).trim();

        switch (key) {
          case "description":
            description = value;
            break;
          case "type":
            if (["user", "feedback", "project", "reference"].includes(value)) {
              type = value as MemoryEntry["type"];
            }
            break;
        }
      }

      memoryContent = lines.slice(i + 1).join("\n").trim();
    }

    return {
      name,
      description,
      type,
      content: memoryContent,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
  }

  private formatMemoryFile(entry: MemoryEntry): string {
    return [
      "---",
      `name: ${entry.name}`,
      `description: ${entry.description}`,
      `type: ${entry.type}`,
      "---",
      "",
      entry.content,
    ].join("\n");
  }

  private async updateIndex(entry: MemoryEntry): Promise<void> {
    await this.ensureDir();
    const indexPath = join(this.memoryDir, MEMORY_INDEX);
    let index = "";
    try {
      index = await readFile(indexPath, "utf-8");
    } catch {
      // no index yet
    }

    const link = `- [${entry.name}](${entry.name}.md) — ${entry.description}`;
    if (index.includes(`${entry.name}.md`)) {
      // Update existing line
      const lines = index.split("\n");
      const newLines = lines.map((l) =>
        l.includes(`${entry.name}.md`) ? link : l,
      );
      await writeFile(indexPath, newLines.join("\n"), "utf-8");
    } else {
      await writeFile(indexPath, (index + link + "\n").trimStart(), "utf-8");
    }
  }

  private async removeFromIndex(name: string): Promise<void> {
    const indexPath = join(this.memoryDir, MEMORY_INDEX);
    try {
      let index = await readFile(indexPath, "utf-8");
      const lines = index.split("\n");
      const newLines = lines.filter((l) => !l.includes(`${name}.md`));
      await writeFile(indexPath, newLines.join("\n"), "utf-8");
    } catch {
      // no index
    }
  }
}
