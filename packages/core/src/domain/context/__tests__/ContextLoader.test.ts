import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { ContextLoader } from "../ContextLoader.js";

describe("ContextLoader", () => {
  const loader = new ContextLoader();
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("loads the fixed whitelist first, then ordered recursive instruction files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "context-loader-"));
    roots.push(rootDir);
    const externalDir = await mkdtemp(join(tmpdir(), "context-loader-target-"));
    roots.push(externalDir);
    const files = [
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "CONTRIBUTING.md",
      ".cursorrules",
      ".github/copilot-instructions.md",
      ".customer-agent/AGENTS.md",
      ".customer-agent/CLAUDE.md",
      ".customer-agent/README.md",
      ".customer-agent/CONTRIBUTING.md",
      ".customer-agent/.cursorrules",
      ".customer-agent/.github/copilot-instructions.md",
      "apps/api/AGENTS.md",
      "packages/ui/CLAUDE.md",
    ];
    for (const file of files) {
      if (file === "AGENTS.md") continue;
      const path = join(rootDir, file);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `content:${file}`);
    }
    await writeFile(join(externalDir, "AGENTS.md"), "content:AGENTS.md");
    await symlink(join(externalDir, "AGENTS.md"), join(rootDir, "AGENTS.md"));
    await symlink(join(externalDir, "AGENTS.md"), join(rootDir, "packages/ui/AGENTS.md"));
    await mkdir(join(rootDir, "node_modules/package"), { recursive: true });
    await writeFile(join(rootDir, "node_modules/package/AGENTS.md"), "excluded");
    await mkdir(join(rootDir, ".git/hooks"), { recursive: true });
    await writeFile(join(rootDir, ".git/hooks/CLAUDE.md"), "excluded");
    await mkdir(join(rootDir, "dist/output"), { recursive: true });
    await writeFile(join(rootDir, "dist/output/AGENTS.md"), "excluded");
    await mkdir(join(rootDir, ".next/cache"), { recursive: true });
    await writeFile(join(rootDir, ".next/cache/AGENTS.md"), "excluded");
    await mkdir(join(rootDir, ".claude/worktrees/old-branch"), { recursive: true });
    await writeFile(join(rootDir, ".claude/worktrees/old-branch/CLAUDE.md"), "excluded");
    await writeFile(join(rootDir, "notes.md"), "arbitrary markdown");

    const loaded = await loader.loadProjectContext(rootDir);

    expect(loaded.map((file) => relative(rootDir, file.path))).toEqual(files);
    expect(loaded.map((file) => file.content)).toEqual(files.map((file) => `content:${file}`));
    expect(loaded.filter((file) => file.type === "claude_md")).toHaveLength(6);
  });

  it("tolerates missing whitelist files", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "context-loader-"));
    roots.push(rootDir);
    await mkdir(join(rootDir, ".customer-agent"), { recursive: true });
    await writeFile(join(rootDir, ".customer-agent/AGENTS.md"), "agent instructions");

    await expect(loader.loadProjectContext(rootDir)).resolves.toMatchObject([
      { path: join(rootDir, ".customer-agent/AGENTS.md"), content: "agent instructions" },
    ]);
  });

  it("loads root whitelist files without recursively scanning a home directory", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "context-loader-home-"));
    roots.push(rootDir);
    await writeFile(join(rootDir, "CLAUDE.md"), "root instructions");
    await mkdir(join(rootDir, "nested"), { recursive: true });
    await writeFile(join(rootDir, "nested/AGENTS.md"), "nested instructions");

    const loaded = await new ContextLoader(rootDir).loadProjectContext(rootDir);

    expect(loaded.map((file) => relative(rootDir, file.path))).toEqual(["CLAUDE.md"]);
  });

  it("rejects a recursive instruction file swapped for an external symlink before reading", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "context-loader-"));
    roots.push(rootDir);
    const externalDir = await mkdtemp(join(tmpdir(), "context-loader-target-"));
    roots.push(externalDir);
    const recursivePath = join(rootDir, "nested/AGENTS.md");
    const externalPath = join(externalDir, "AGENTS.md");
    await mkdir(join(recursivePath, ".."), { recursive: true });
    await writeFile(recursivePath, "in-root");
    await writeFile(externalPath, "outside");

    class SwappingContextLoader extends ContextLoader {
      override async findClaudeMdFiles(directory: string): Promise<string[]> {
        const discovered = await super.findClaudeMdFiles(directory);
        await rm(recursivePath);
        await symlink(externalPath, recursivePath);
        return discovered;
      }
    }

    await expect(new SwappingContextLoader().loadProjectContext(rootDir)).resolves.toEqual([]);
  });

  it("rejects a recursive instruction parent swapped for an external symlink before reading", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "context-loader-"));
    roots.push(rootDir);
    const externalDir = await mkdtemp(join(tmpdir(), "context-loader-target-"));
    roots.push(externalDir);
    const nestedDir = join(rootDir, "nested");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "AGENTS.md"), "in-root");
    await writeFile(join(externalDir, "AGENTS.md"), "outside");

    class SwappingParentContextLoader extends ContextLoader {
      override async findClaudeMdFiles(directory: string): Promise<string[]> {
        const discovered = await super.findClaudeMdFiles(directory);
        await rm(nestedDir, { recursive: true });
        await symlink(externalDir, nestedDir);
        return discovered;
      }
    }

    await expect(new SwappingParentContextLoader().loadProjectContext(rootDir)).resolves.toEqual([]);
  });
});
