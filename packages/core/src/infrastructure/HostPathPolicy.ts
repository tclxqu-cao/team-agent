import {
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "node:fs";
import {
  basename,
  delimiter,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

export type HostPathErrorCode =
  | "PATH_OUTSIDE_ROOT"
  | "PATH_NOT_FOUND"
  | "PATH_NOT_DIRECTORY"
  | "PATH_UNREADABLE";

export class HostPathError extends Error {
  readonly code: HostPathErrorCode;

  constructor(code: HostPathErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "HostPathError";
    this.code = code;
  }
}

export interface HostDirectoryEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
  hasChildren: boolean;
}

function toHostPathError(error: unknown, candidate: string): HostPathError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new HostPathError("PATH_NOT_FOUND", `路径不存在：${candidate}`, { cause: error });
  }
  return new HostPathError("PATH_UNREADABLE", `无法访问路径：${candidate}`, { cause: error });
}

function canonicalPath(candidate: string): string {
  const normalized = resolve(candidate);
  try {
    return realpathSync.native(normalized);
  } catch (error) {
    throw toHostPathError(error, normalized);
  }
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export class HostPathPolicy {
  readonly roots: string[];

  constructor(roots: string[]) {
    const canonicalRoots: string[] = [];
    for (const candidate of roots) {
      if (!candidate?.trim()) continue;
      const canonical = canonicalPath(candidate.trim());
      let stat;
      try {
        stat = statSync(canonical);
      } catch (error) {
        throw toHostPathError(error, canonical);
      }
      if (!stat.isDirectory()) {
        throw new HostPathError("PATH_NOT_DIRECTORY", `不是目录：${canonical}`);
      }
      if (!canonicalRoots.includes(canonical)) canonicalRoots.push(canonical);
    }
    if (canonicalRoots.length === 0) {
      throw new HostPathError("PATH_UNREADABLE", "没有可用的宿主机目录根路径");
    }
    this.roots = canonicalRoots;
  }

  static fromEnvironment(value: string | undefined, fallbackRoot: string): HostPathPolicy {
    const configured = value?.trim() ? value : fallbackRoot;
    return new HostPathPolicy(configured.split(delimiter));
  }

  assertAllowed(candidate: string): string {
    if (typeof candidate !== "string" || !candidate.trim()) {
      throw new HostPathError("PATH_NOT_FOUND", "路径不能为空");
    }
    const canonical = canonicalPath(candidate.trim());
    if (!this.roots.some((root) => isPathInsideRoot(root, canonical))) {
      throw new HostPathError("PATH_OUTSIDE_ROOT", `路径不在允许范围内：${canonical}`);
    }
    return canonical;
  }

  assertDirectory(candidate: string): string {
    const canonical = this.assertAllowed(candidate);
    let stat;
    try {
      stat = statSync(canonical);
    } catch (error) {
      throw toHostPathError(error, canonical);
    }
    if (!stat.isDirectory()) {
      throw new HostPathError("PATH_NOT_DIRECTORY", `不是目录：${canonical}`);
    }
    return canonical;
  }

  listDirectories(candidate: string): HostDirectoryEntry[] {
    const canonical = this.assertDirectory(candidate);
    let dirents: Dirent[];
    try {
      dirents = readdirSync(canonical, { withFileTypes: true });
    } catch (error) {
      throw toHostPathError(error, canonical);
    }

    const entries: HostDirectoryEntry[] = [];
    for (const dirent of dirents) {
      const displayedPath = resolve(canonical, dirent.name);
      let child: string;
      try {
        child = this.assertAllowed(displayedPath);
      } catch {
        continue;
      }

      let kind: HostDirectoryEntry["kind"];
      try {
        const stat = statSync(child);
        if (stat.isDirectory()) kind = "directory";
        else if (stat.isFile()) kind = "file";
        else continue;
      } catch {
        continue;
      }

      entries.push({
        name: dirent.name || basename(child),
        path: child,
        kind,
        hasChildren: kind === "directory" && this.hasAllowedDirectoryChild(child),
      });
    }

    return entries.sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      const leftHidden = left.name.startsWith(".");
      const rightHidden = right.name.startsWith(".");
      if (leftHidden !== rightHidden) return leftHidden ? 1 : -1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    });
  }

  private hasAllowedDirectoryChild(candidate: string): boolean {
    try {
      return readdirSync(candidate, { withFileTypes: true }).some((entry) => {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) return false;
        try {
          this.assertDirectory(resolve(candidate, entry.name));
          return true;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }
}
