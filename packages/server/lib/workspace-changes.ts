import { execFile } from "node:child_process";
import type { WorkspaceChange, WorkspaceChanges } from "../../core/src/domain/file-workspace/workspace-changes";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["--no-optional-locks", "-c", "core.quotepath=false", ...args], {
      cwd, encoding: "utf8", timeout: 8_000, maxBuffer: 8 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { gitStderr: stderr }));
      else resolve(stdout);
    });
  });
}

function status(code: string): WorkspaceChange["status"] {
  if (code === "??") return "untracked";
  if (code.includes("U") || code === "AA" || code === "DD") return "conflict";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

/** Read-only Git snapshot; the caller validates both the directory and repo root. */
export async function readWorkspaceChanges(
  directory: string,
  assertDirectory: (path: string) => string,
): Promise<WorkspaceChanges> {
  const cwd = assertDirectory(directory);
  let root: string;
  try {
    root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if (/not a git repository/i.test(String((error as { gitStderr?: string }).gitStderr))) {
      return { repository: false, root: null, branch: null, files: [] };
    }
    throw error;
  }
  root = assertDirectory(root);
  // An unborn branch has no HEAD: diff the index against its working tree.
  const head = await git(root, ["rev-parse", "--verify", "HEAD"]).then(() => true, () => false);
  const [branch, porcelain, numstat] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null),
    git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=normal", "--no-renames", "--ignore-submodules=all"]),
    git(root, ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", ...(head ? ["HEAD"] : []), "--", "."]),
  ]);
  const counts = new Map<string, { added: number | null; removed: number | null }>();
  for (const record of numstat.split("\0")) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (match) counts.set(match[3], {
      added: match[1] === "-" ? null : Number(match[1]),
      removed: match[2] === "-" ? null : Number(match[2]),
    });
  }
  const files = porcelain.split("\0").filter(Boolean).map((record): WorkspaceChange => ({
    path: record.slice(3),
    status: status(record.slice(0, 2)),
    ...(counts.get(record.slice(3)) ?? { added: null, removed: null }),
  }));
  return { repository: true, root, branch: branch?.trim() || null, files };
}
