import type { IContextLoader, ProjectFile } from './entities.js';
import { constants } from "node:fs";
import { open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, basename, isAbsolute, relative, resolve, sep } from "node:path";

const ROOT_PROJECT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "CONTRIBUTING.md",
  ".cursorrules",
  ".github/copilot-instructions.md",
];
const CUSTOMER_AGENT_FILES = ROOT_PROJECT_FILES.map((file) => join(".customer-agent", file));
const INSTRUCTION_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

export class ContextLoader implements IContextLoader {
  async loadProjectContext(rootDir: string): Promise<ProjectFile[]> {
    const files: ProjectFile[] = [];
    const loadedPaths = new Set<string>();

    // Load known project files in contract order.
    for (const relPath of [...ROOT_PROJECT_FILES, ...CUSTOMER_AGENT_FILES]) {
      const fullPath = join(rootDir, relPath);
      if (loadedPaths.has(fullPath)) continue;
      try {
        await stat(fullPath);
        const file = await this.loadFile(fullPath);
        files.push(file);
        loadedPaths.add(fullPath);
      } catch {
        // Missing or unreadable files are optional context.
      }
    }

    // Find additional instruction files in subdirectories.
    try {
      const resolvedRoot = await realpath(rootDir);
      const instructionFiles = await this.findClaudeMdFiles(rootDir);
      for (const filePath of instructionFiles) {
        if (loadedPaths.has(filePath)) continue;
        try {
          const file = await this.loadRecursiveFile(rootDir, resolvedRoot, filePath);
          files.push(file);
          loadedPaths.add(filePath);
        } catch {
          // Skip files that disappear or become unreadable during discovery.
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
    if (INSTRUCTION_FILES.has(fileName)) type = "claude_md";
    else if (fileName === "README.md" || fileName === "CONTRIBUTING.md") type = "readme";
    else if (fileName.endsWith(".md")) type = "config";
    else if (fileName.endsWith(".ts") || fileName.endsWith(".js") || fileName.endsWith(".py")) type = "code";

    return { path: filePath, content, type };
  }

  private async loadRecursiveFile(rootDir: string, resolvedRoot: string, filePath: string): Promise<ProjectFile> {
    const relativePath = relative(rootDir, filePath);
    if (
      !relativePath ||
      isAbsolute(relativePath) ||
      relativePath === ".." ||
      relativePath.startsWith(`..${sep}`)
    ) {
      throw new Error("Recursive context candidate is outside the configured root");
    }

    const expectedPath = resolve(resolvedRoot, relativePath);
    const fileHandle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const openedStat = await fileHandle.stat();
      if (!openedStat.isFile()) {
        throw new Error("Recursive context candidate is not a regular file");
      }

      const resolvedPath = await realpath(filePath);
      if (resolvedPath !== expectedPath) {
        throw new Error("Recursive context candidate traverses a symbolic link");
      }

      const resolvedStat = await stat(resolvedPath);
      if (resolvedStat.dev !== openedStat.dev || resolvedStat.ino !== openedStat.ino) {
        throw new Error("Recursive context candidate changed while opening");
      }

      const content = await fileHandle.readFile({ encoding: "utf-8" });
      return { path: filePath, content, type: "claude_md" };
    } finally {
      await fileHandle.close();
    }
  }

  async findClaudeMdFiles(rootDir: string): Promise<string[]> {
    const results: string[] = [];

    const scan = async (dir: string) => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;

          const fullPath = join(dir, entry.name);
          if (entry.isDirectory()) {
            await scan(fullPath);
          } else if (entry.isFile() && INSTRUCTION_FILES.has(entry.name)) {
            results.push(fullPath);
          }
        }
      } catch {
        // skip inaccessible directories
      }
    };

    await scan(rootDir);
    return results.sort((left, right) => left.localeCompare(right));
  }
}
