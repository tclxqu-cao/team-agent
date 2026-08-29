import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ActiveTrigger, PaletteItem } from "./palette.js";
import { replaceTrigger } from "./palette.js";

const DEFAULT_IGNORES = new Set([
  ".git",
  ".next",
  ".cache",
  ".turbo",
  "node_modules",
  "dist",
  "build",
  "coverage",
]);
const PROJECT_MARKERS = [".git", "package.json", "pom.xml", "build.gradle", "settings.gradle", "go.mod", "Cargo.toml", "pyproject.toml"];
const HOME_ROOT_IGNORES = new Set(["Applications", "Library", "Movies", "Music", "Pictures", "Public"]);
const PROJECT_METADATA_FILES = ["README.md", "docs/project-context.md", "AGENTS.md", "CLAUDE.md"];
const DEFAULT_METADATA_BYTES = 8 * 1024;

export interface RegisteredProject {
  id: string;
  name: string;
  description: string;
  source?: string;
}

export interface ProjectCandidate extends PaletteItem {
  kind: "project";
  path?: string;
}

export interface ResourceIndexResult {
  items: PaletteItem[];
  warnings: string[];
  truncated: boolean;
}

async function readFilePrefix(filePath: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function projectSearchText(projectPath: string, label: string, maxBytes: number): Promise<string> {
  const prefixes = await Promise.all(PROJECT_METADATA_FILES.map(async (relativePath) => {
    try {
      return await readFilePrefix(path.join(projectPath, relativePath), maxBytes);
    } catch {
      return "";
    }
  }));
  return [label, projectPath, ...prefixes].filter(Boolean).join("\n");
}

// macOS delivers pty resize signals (SIGWINCH — the phone keyboard opening is
// a resize) that interrupt slow syscalls mid-flight; libuv surfaces those as
// EINTR. Retry briefly instead of failing the whole resource index.
async function withEintrRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      if (error?.code !== "EINTR" || attempt >= 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

export async function scanSiblingProjects(
  cwd: string,
  options: { homeDirectory?: string; metadataBytes?: number } = {},
): Promise<ProjectCandidate[]> {
  const currentRealPath = await withEintrRetry(() => fsp.realpath(cwd));
  let homeRealPath = path.resolve(options.homeDirectory ?? os.homedir());
  try {
    homeRealPath = await withEintrRetry(() => fsp.realpath(homeRealPath));
  } catch {}
  const searchRoot = currentRealPath === homeRealPath ? currentRealPath : path.dirname(currentRealPath);
  const dir = await withEintrRetry(() => fsp.opendir(searchRoot));
  const projects: ProjectCandidate[] = [];
  for await (const entry of dir) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || DEFAULT_IGNORES.has(entry.name)) continue;
    let candidatePath: string;
    try {
      candidatePath = await withEintrRetry(() => fsp.realpath(path.join(searchRoot, entry.name)));
    } catch {
      continue;
    }
    const markerChecks = await Promise.all(PROJECT_MARKERS.map(async (marker) => {
      try {
        await fsp.access(path.join(candidatePath, marker));
        return true;
      } catch {
        return false;
      }
    }));
    if (candidatePath !== currentRealPath && !markerChecks.some(Boolean)) continue;
    projects.push({
      id: `project:path:${candidatePath}`,
      kind: "project",
      label: entry.name,
      description: candidatePath === currentRealPath ? "当前项目" : candidatePath,
      value: candidatePath,
      path: candidatePath,
      metadata: {
        searchText: await projectSearchText(candidatePath, entry.name, options.metadataBytes ?? DEFAULT_METADATA_BYTES),
      },
    });
  }
  return projects.sort((a, b) => a.label.localeCompare(b.label));
}

async function existingAbsoluteDirectory(value: string): Promise<string | undefined> {
  if (!path.isAbsolute(value)) return undefined;
  try {
    const stat = await fsp.stat(value);
    return stat.isDirectory() ? await fsp.realpath(value) : undefined;
  } catch {
    return undefined;
  }
}

export async function mergeProjects(
  discovered: readonly ProjectCandidate[],
  registered: readonly RegisteredProject[],
): Promise<ProjectCandidate[]> {
  const byName = new Map(discovered.map((project) => [project.label.toLowerCase(), project]));
  const byPath = new Map(discovered.filter((project) => project.path).map((project) => [project.path!, project]));

  for (const record of registered) {
    const matched = byName.get(record.name.trim().toLowerCase());
    const explicitPath = matched?.path ?? await existingAbsoluteDirectory(record.description.trim());
    if (explicitPath) {
      const existing = byPath.get(explicitPath);
      if (existing) {
        existing.metadata = {
          ...existing.metadata,
          registeredId: record.id,
          source: record.source ?? "database",
          searchText: [existing.metadata?.searchText, record.name, record.description].filter(Boolean).join("\n"),
        };
        continue;
      }
    }

    const project: ProjectCandidate = {
      id: `project:registered:${record.source ?? "database"}:${record.id}`,
      kind: "project",
      label: record.name,
      description: explicitPath ?? "未找到目录",
      value: explicitPath ?? record.name,
      path: explicitPath,
      disabled: !explicitPath,
      metadata: {
        registeredId: record.id,
        source: record.source ?? "database",
        searchText: [record.name, record.description, explicitPath].filter(Boolean).join("\n"),
      },
    };
    if (explicitPath) byPath.set(explicitPath, project);
    byName.set(record.name.trim().toLowerCase(), project);
  }

  return [...byPath.values(), ...[...byName.values()].filter((item) => !item.path)]
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || a.label.localeCompare(b.label));
}

export async function indexProjectResources(
  root: string,
  options: { maxEntries?: number; ignoredNames?: ReadonlySet<string>; homeDirectory?: string } = {},
): Promise<ResourceIndexResult> {
  const maxEntries = options.maxEntries ?? 10_000;
  const ignored = options.ignoredNames ?? DEFAULT_IGNORES;
  const rootPath = path.resolve(root);
  const isHomeRoot = rootPath === path.resolve(options.homeDirectory ?? os.homedir());
  const items: PaletteItem[] = [];
  const warnings: string[] = [];
  const queue = [root];
  let truncated = false;

  while (queue.length > 0 && items.length < maxEntries) {
    const current = queue.shift()!;
    let entries;
    try {
      entries = await withEintrRetry(() => fsp.readdir(current, { withFileTypes: true }));
    } catch (error) {
      warnings.push(`${current}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const entry of entries) {
      if (ignored.has(entry.name) || (entry.name.startsWith(".") && entry.name !== ".env.example")) continue;
      if (isHomeRoot && current === rootPath && HOME_ROOT_IGNORES.has(entry.name)) continue;
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        items.push({ id: `folder:${relative}`, kind: "folder", label: relative, description: "文件夹", value: relative });
        queue.push(absolute);
      } else if (entry.isFile()) {
        items.push({ id: `file:${relative}`, kind: "file", label: relative, description: "文件", value: relative });
      }
      if (items.length >= maxEntries) {
        truncated = true;
        break;
      }
    }
  }

  items.sort((a, b) =>
    Number(a.kind === "file") - Number(b.kind === "file")
    || a.value.split("/").length - b.value.split("/").length
    || a.value.localeCompare(b.value));
  return { items, warnings, truncated };
}

export function replaceMentionToken(
  buffer: string,
  cursor: number,
  trigger: ActiveTrigger,
  relativePath: string,
): { buffer: string; cursor: number } {
  const normalized = relativePath.split(path.sep).join("/");
  const value = /\s/.test(normalized) ? `@"${normalized}" ` : `@${normalized} `;
  return replaceTrigger(buffer, cursor, trigger, value);
}
