import type { ISkillLoader, SkillDefinition, SkillMeta, SkillSource } from './entities.js';
import { readFile, readdir, stat, mkdir, copyFile, cp } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import { homedir } from "node:os";

const SKILL_MD = "SKILL.md";

/** Third-party AI tool config dirs (relative to home or project root) */
const THIRD_PARTY_TOOLS: Array<{ dir: string; source: SkillSource }> = [
  { dir: ".claude",  source: "claude"  },
  { dir: ".cursor",  source: "cursor"  },
  { dir: ".github",  source: "github"  },
  { dir: ".codex",   source: "codex"   },
  { dir: ".copilot", source: "copilot" },
];

export class SkillLoader implements ISkillLoader {
  /** Load skill metadata from a directory (frontmatter only, no prompt body) */
  async loadFromDirectory(dirPath: string, source: SkillSource = "custom"): Promise<SkillMeta[]> {
    const skills: SkillMeta[] = [];
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        // Use stat() so symlinks to directories are treated as directories
        const entryPath = join(dirPath, entry.name);
        try {
          const s = await stat(entryPath);
          if (!s.isDirectory()) continue;
        } catch { continue; }
        const skillMdPath = join(dirPath, entry.name, SKILL_MD);
        try {
          await stat(skillMdPath);
          const meta = await this.loadMeta(skillMdPath, source);
          skills.push(meta);
        } catch {
          // No SKILL.md in this directory
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return skills;
  }

  /**
   * Auto-discover skills from all known locations in priority order:
   *   1. project:  <projectDir>/.agent/skills/
   *   2. global:   ~/.agent/skills/
   *   3. project third-party: <projectDir>/.<tool>/skills/
   *   4. global  third-party: ~/.<tool>/skills/
   *
   * Duplicate names are resolved by the first (highest-priority) occurrence.
   */
  /** Synchronous variant of loadFromDirectory for Electron */
  loadFromDirectorySync(dirPath: string, source: SkillSource = "custom"): SkillMeta[] {
    const skills: SkillMeta[] = [];
    try {
      const entries = readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        try {
          const s = statSync(entryPath);
          if (!s.isDirectory()) continue;
        } catch { continue; }
        const skillMdPath = join(dirPath, entry.name, SKILL_MD);
        try {
          statSync(skillMdPath);
          const content = readFileSync(skillMdPath, "utf-8");
          const meta = this.parseFrontmatterOnly(content, skillMdPath, source);
          skills.push(meta);
        } catch {
          // No SKILL.md in this directory
        }
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
    return skills;
  }

  /** Synchronous variant of loadAll for Electron */
  loadAllSync(projectDir: string): SkillMeta[] {
    const home = homedir();
    const candidateDirs: Array<{ dir: string; source: SkillSource }> = [
      { dir: join(projectDir, ".agent", "skills"), source: "project" },
      { dir: join(home, ".agent", "skills"),        source: "global"  },
      { dir: join(home, ".agents", "skills"),       source: "global"  },
      ...THIRD_PARTY_TOOLS.map(({ dir, source }) => ({ dir: join(projectDir, dir, "skills"), source })),
      ...THIRD_PARTY_TOOLS.map(({ dir, source }) => ({ dir: join(home, dir, "skills"), source })),
    ];

    const seen = new Set<string>();
    const results: SkillMeta[] = [];
    for (const { dir, source } of candidateDirs) {
      const skills = this.loadFromDirectorySync(dir, source);
      for (const skill of skills) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          results.push(skill);
        }
      }
    }
    return results;
  }

  /**
   * Auto-discover skills from all known locations in priority order:
   *   1. project:  <projectDir>/.agent/skills/
   *   2. global:   ~/.agent/skills/
   *   3. global:   ~/.agents/skills/
   *   4. project third-party: <projectDir>/.<tool>/skills/
   *   5. global  third-party: ~/.<tool>/skills/
   *
   * Duplicate names are resolved by the first (highest-priority) occurrence.
   */
  async loadAll(projectDir: string): Promise<SkillMeta[]> {
    const home = homedir();
    const candidateDirs: Array<{ dir: string; source: SkillSource }> = [
      { dir: join(projectDir, ".agent", "skills"), source: "project" },
      { dir: join(home, ".agent", "skills"),        source: "global"  },
      { dir: join(home, ".agents", "skills"),       source: "global"  },
      ...THIRD_PARTY_TOOLS.map(({ dir, source }) => ({ dir: join(projectDir, dir, "skills"), source })),
      ...THIRD_PARTY_TOOLS.map(({ dir, source }) => ({ dir: join(home, dir, "skills"), source })),
    ];

    const seen = new Set<string>();
    const results: SkillMeta[] = [];
    for (const { dir, source } of candidateDirs) {
      const skills = await this.loadFromDirectory(dir, source);
      for (const skill of skills) {
        if (!seen.has(skill.name)) {
          seen.add(skill.name);
          results.push(skill);
        }
      }
    }
    return results;
  }

  async loadFromFile(filePath: string): Promise<SkillDefinition> {
    const content = await readFile(filePath, "utf-8");
    return this.parseSkillMd(content, filePath);
  }

  /** Synchronous variant of loadFromFile for Electron */
  loadFromFileSync(filePath: string): SkillDefinition {
    const content = readFileSync(filePath, "utf-8");
    return this.parseSkillMd(content, filePath);
  }

  /**
   * Install a skill into targetSkillsDir by copying its source.
   * sourcePath may be:
   *   - a directory that contains SKILL.md  → the whole directory is copied
   *   - a path pointing directly to SKILL.md → only that file is copied
   * Destination: <targetSkillsDir>/<skillName>/SKILL.md
   */
  async installSkill(sourcePath: string, targetSkillsDir: string): Promise<SkillMeta> {
    let skillMdPath: string;
    let skillDirPath: string;

    const srcStat = await stat(sourcePath);
    if (srcStat.isDirectory()) {
      skillMdPath = join(sourcePath, SKILL_MD);
      skillDirPath = sourcePath;
      await stat(skillMdPath); // throws if SKILL.md missing
    } else {
      skillMdPath = sourcePath;
      skillDirPath = dirname(sourcePath);
    }

    const meta = await this.loadMeta(skillMdPath, "project");
    const destDir = join(targetSkillsDir, meta.name);
    await mkdir(destDir, { recursive: true });

    if (srcStat.isDirectory()) {
      await cp(skillDirPath, destDir, { recursive: true });
    } else {
      await copyFile(skillMdPath, join(destDir, SKILL_MD));
    }

    return { ...meta, filePath: join(destDir, SKILL_MD), source: "global" };
  }

  private async loadMeta(filePath: string, source: SkillSource): Promise<SkillMeta> {
    const content = await readFile(filePath, "utf-8");
    return this.parseFrontmatterOnly(content, filePath, source);
  }

  /** Parse only the YAML frontmatter block — skips the prompt body */
  private parseFrontmatterOnly(content: string, filePath: string, source: SkillSource): SkillMeta {
    const lines = content.split("\n");
    // Prefer the parent directory name over the file basename (SKILL.md convention)
    const fileBaseName = basename(filePath, extname(filePath));
    const dirName = basename(dirname(filePath));
    let name = fileBaseName === "SKILL" ? dirName : fileBaseName;
    let description = "";
    const triggers: string[] = [];
    const tools: string[] = [];

    if (lines[0]?.trim() !== "---") {
      return { name, description, triggers: [name.toLowerCase()], filePath, source };
    }

    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") break;
      const colonIdx = lines[i].indexOf(":");
      if (colonIdx === -1) continue;
      // Strip leading '#' chars to handle "## name: value" (Markdown-prefixed) frontmatter
      const key = lines[i].slice(0, colonIdx).trim().replace(/^#+\s*/, "").toLowerCase();
      const rawValue = lines[i].slice(colonIdx + 1).trim();

      // Handle YAML block scalars: "key: >" or "key: |" — collect indented continuation lines
      let value = rawValue;
      if (rawValue === ">" || rawValue === "|") {
        const blockLines: string[] = [];
        while (i + 1 < lines.length && lines[i + 1].trim() !== "---") {
          const next = lines[i + 1];
          // Block content must be indented (starts with whitespace)
          if (next.length > 0 && !/^\s/.test(next) && next.includes(":")) break;
          i++;
          blockLines.push(lines[i].trim());
        }
        value = blockLines.filter(Boolean).join(" ");
      }

      switch (key) {
        case "name": name = value; break;
        case "description": description = value; break;
        case "triggers":
          triggers.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
          break;
        case "tools":
          tools.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
          break;
      }
    }

    return {
      name,
      description,
      triggers: triggers.length > 0 ? triggers : [name.toLowerCase()],
      ...(tools.length > 0 ? { tools } : {}),
      filePath,
      source,
    };
  }

  private parseSkillMd(content: string, filePath: string): SkillDefinition {
    const lines = content.split("\n");
    let name = basename(filePath, extname(filePath));
    let description = "";
    const triggers: string[] = [];
    let prompt = "";
    const tools: string[] = [];
    let frontmatterLines: string[] = [];
    let contentStart = 0;

    if (lines[0]?.trim() === "---") {
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].trim() === "---") {
          contentStart = i + 1;
          break;
        }
        frontmatterLines.push(lines[i]);
      }
    }

    for (const line of frontmatterLines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();
      switch (key) {
        case "name": name = value; break;
        case "description": description = value; break;
        case "triggers":
          triggers.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
          break;
        case "tools":
          tools.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
          break;
      }
    }

    prompt = lines.slice(contentStart).join("\n").trim();
    const source = this.inferSource(filePath);

    return {
      name,
      description,
      triggers: triggers.length > 0 ? triggers : [name.toLowerCase()],
      prompt,
      tools,
      filePath,
      source,
    };
  }

  private inferSource(filePath: string): SkillSource {
    const home = homedir();
    const normalized = filePath.replace(/\\/g, "/");
    if (normalized.includes("/.agent/skills/")) {
      return normalized.startsWith(home.replace(/\\/g, "/")) ? "global" : "project";
    }
    for (const { dir, source } of THIRD_PARTY_TOOLS) {
      if (normalized.includes(`/${dir}/skills/`)) return source;
    }
    return "custom";
  }
}
