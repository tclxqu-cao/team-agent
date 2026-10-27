import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";

/** ACP lists only one cwd; native transcript headers identify the other roots. */
export class QoderWorkspaceCatalog {
  private readonly cache = new Map<string, { stamp: string; roots: string[] }>();

  constructor(private readonly root = join(homedir(), ".qoder", "projects")) {}

  private async roots(path: string): Promise<string[]> {
    const input = createReadStream(path);
    const lines = createInterface({ input, crlfDelay: Infinity });
    const roots = new Set<string>();
    try {
      for await (const line of lines) {
        let row: Record<string, unknown>;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || typeof row !== "object") continue;
        if (typeof row.cwd === "string" && isAbsolute(row.cwd)) return [row.cwd];
        if (row.type === "workspace-directories" && Array.isArray(row.directories)) {
          for (const cwd of row.directories) if (typeof cwd === "string" && isAbsolute(cwd)) roots.add(cwd);
        }
      }
      return [...roots];
    } finally {
      lines.close();
      input.destroy();
    }
  }

  async list(): Promise<string[]> {
    let directories: Dirent[];
    try { directories = await readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const roots = new Set<string>();
    const found = new Set<string>();
    for (const directory of directories) {
      if (!directory.isDirectory()) continue;
      const path = join(this.root, directory.name);
      let files: Dirent[];
      try { files = await readdir(path, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const file of files) {
        if (!file.isFile() || !/^[a-zA-Z0-9_-]+\.jsonl$/.test(file.name)) continue;
        const filename = join(path, file.name);
        try {
          const info = await stat(filename);
          const stamp = `${info.mtimeMs}:${info.size}`;
          let cached = this.cache.get(filename);
          if (cached?.stamp !== stamp) {
            cached = { stamp, roots: await this.roots(filename) };
            this.cache.set(filename, cached);
          }
          found.add(filename);
          for (const cwd of cached.roots) roots.add(cwd);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
    }
    for (const path of this.cache.keys()) if (!found.has(path)) this.cache.delete(path);
    return [...roots].sort();
  }
}
