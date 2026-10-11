export interface FileLineStats {
  added: number;
  removed: number;
}

export type FileChangeOperation = "add" | "update" | "delete";

export interface FileChangeSummary {
  operation: FileChangeOperation;
  fileCount: number;
  lineStats: FileLineStats | null;
}

export function textLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function fileChangeOperation(change: Record<string, unknown>): FileChangeOperation | null {
  const kind = typeof change.kind === "string" ? change.kind : (change.kind as { type?: unknown } | null)?.type;
  return kind === "add" || kind === "update" || kind === "delete" ? kind : null;
}

export function isFileLineStats(value: unknown): value is FileLineStats {
  if (!value || typeof value !== "object") return false;
  const stats = value as FileLineStats;
  return Number.isSafeInteger(stats.added) && stats.added >= 0
    && Number.isSafeInteger(stats.removed) && stats.removed >= 0;
}

export function fileChangeLineStats(change: Record<string, unknown>): FileLineStats | null {
  if (isFileLineStats(change.lineStats)) return change.lineStats;
  if (typeof change.diff !== "string") return null;
  const operation = fileChangeOperation(change);
  // Codex sends raw file contents for additions/deletions, unified diffs for updates.
  if (operation === "add") return { added: textLines(change.diff).length, removed: 0 };
  if (operation === "delete") return { added: 0, removed: textLines(change.diff).length };
  if (operation !== "update") return null;
  let inHunk = false;
  const stats = { added: 0, removed: 0 };
  for (const line of change.diff.split("\n")) {
    if (/^@@(?: |$)/.test(line)) inHunk = true;
    else if (inHunk && line.startsWith("+")) stats.added += 1;
    else if (inHunk && line.startsWith("-")) stats.removed += 1;
    else if (line.startsWith("diff --git ")) inHunk = false;
  }
  return inHunk ? stats : null;
}

export function summarizeFileChanges(changes: Record<string, unknown>[]): FileChangeSummary | null {
  if (!changes.length) return null;
  const operations = changes.map(fileChangeOperation);
  const operation = operations.every((kind) => kind === "add") ? "add"
    : operations.every((kind) => kind === "delete") ? "delete" : "update";
  const stats = changes.map(fileChangeLineStats);
  return {
    operation,
    fileCount: changes.length,
    lineStats: stats.every((entry) => entry !== null)
      ? stats.reduce<FileLineStats>((total, entry) => ({ added: total.added + entry!.added, removed: total.removed + entry!.removed }), { added: 0, removed: 0 })
      : null,
  };
}

/** Counts changed lines without mistaking large unchanged context for additions. */
export function textLineStats(before: string, after: string): FileLineStats | null {
  const oldLines = textLines(before);
  const newLines = textLines(after);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start += 1;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd -= 1; newEnd -= 1; }
  const removed = oldEnd - start;
  const added = newEnd - start;
  if (removed * added > 200_000) return null;
  const row = new Uint32Array(added + 1);
  for (let i = start; i < oldEnd; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= added; j += 1) {
      const previous = row[j];
      row[j] = oldLines[i] === newLines[start + j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = previous;
    }
  }
  return { added: added - row[added], removed: removed - row[added] };
}
