import type { IContextLoader, ProjectFile } from './entities.js';
import { readFile, readdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";

const PROJECT_FILES = [
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];

export class ContextLoader implements IContextLoader {
  async loadProjectContext(rootDir: string): Promise<ProjectFile[]> {
    const files: ProjectFile[] = [];

    // Load known project files
    for (const relPath of PROJECT_FILES) {
      const fullPath = join(rootDir, relPath);
      try {
        await stat(fullPath);
        const file = await this.loadFile(fullPath);
        files.push(file);
      } catch {
        // file doesn't exist
      }
    }

    // Find additional CLAUDE.md files in subdirectories
    try {
      const claudeFiles = await this.findClaudeMdFiles(rootDir);
      for (const filePath of claudeFiles) {
        // Skip the root one we already loaded
        if (filePath === join(rootDir, "CLAUDE.md")) continue;
        try {
          const file = await this.loadFile(filePath);
          files.push(file);
        } catch {
          // skip
        }
      }
    } catch {
      // directory not accessible
    }

    return files;
  }

  async loadFile(filePath: string): Promise<ProjectFile> {
    const content = await readFile(filePath, "utf-8");
    const fileName = basename(filePath);

    let type: ProjectFile["type"] = "other";
    if (fileName === "CLAUDE.md") type = "claude_md";
    else if (fileName === "README.md" || fileName === "CONTRIBUTING.md") type = "readme";
    else if (fileName.endsWith(".md")) type = "config";
    else if (fileName.endsWith(".ts") || fileName.endsWith(".js") || fileName.endsWith(".py")) type = "code";

    return { path: filePath, content, type };
  }

  async findClaudeMdFiles(rootDir: string): Promise<string[]> {
    const results: string[] = [];

    const scan = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          // Skip node_modules, .git, etc.
          if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "dist") continue;

          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await scan(fullPath);
          } else if (entry.name === "CLAUDE.md") {
            results.push(fullPath);
          }
        }
      } catch {
        // skip inaccessible directories
      }
    };

    await scan(rootDir);
    return results;
  }
}
