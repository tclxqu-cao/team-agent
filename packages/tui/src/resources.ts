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

export async function scanSiblingProjects(cwd: string): Promise<ProjectCandidate[]> {
  const parent = path.dirname(cwd);
  const dir = await fsp.opendir(parent);
  const projects: ProjectCandidate[] = [];
  const currentRealPath = await fsp.realpath(cwd);
  for await (const entry of dir) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || DEFAULT_IGNORES.has(entry.name)) continue;
    const candidatePath = await fsp.realpath(path.join(parent, entry.name));
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
        existing.metadata = { ...existing.metadata, registeredId: record.id, source: record.source ?? "database" };
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
      metadata: { registeredId: record.id, source: record.source ?? "database" },
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
      entries = await fsp.readdir(current, { withFileTypes: true });
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
