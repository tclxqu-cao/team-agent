import { isFileLineStats, summarizeFileChanges, textLineStats, textLines, type FileChangeSummary, type FileLineStats } from "../../../core/src/domain/tool/file-change-summary";

export function patchChanges(args: Record<string, unknown>, result?: string): Record<string, unknown>[] {
  const changes = Array.isArray(args.changes)
    ? args.changes.filter((change): change is Record<string, unknown> => Boolean(change) && typeof change === "object")
    : [];
  // Older runtime hosts omitted diff text before compact line counts existed.
  if (result && (!changes.length || (args.__truncated && !args.fileChangeSummary))) {
    try {
      const parsed: unknown = JSON.parse(result);
      if (Array.isArray(parsed)) return parsed.filter((change) => Boolean(change) && typeof change === "object");
    } catch { /* A failed tool can return plain text instead of file changes. */ }
  }
  return changes;
}

export function patchSummary(args: Record<string, unknown>, result?: string): FileChangeSummary | null {
  const summary = args.fileChangeSummary as FileChangeSummary | undefined;
  if (summary && ["add", "update", "delete"].includes(summary.operation)
    && Number.isSafeInteger(summary.fileCount) && summary.fileCount > 0
    && (summary.lineStats === null || isFileLineStats(summary.lineStats))) return summary;
  return summarizeFileChanges(patchChanges(args, result));
}

export function patchActivityLabel(summary: FileChangeSummary | null): string {
  return summary?.operation === "add" ? "写入" : summary?.operation === "delete" ? "删除" : "编辑";
}

export function editLineStats(args: Record<string, unknown>): FileLineStats | null {
  if (args.__truncated || args.replace_all === true) return null;
  if (typeof args.old_string !== "string" || typeof args.new_string !== "string") return null;
  return textLineStats(args.old_string, args.new_string);
}

export function multiEditLineStats(args: Record<string, unknown>): FileLineStats | null {
  if (args.__truncated || !Array.isArray(args.edits) || !args.edits.length) return null;
  const stats = args.edits.map((edit) => edit && typeof edit === "object" ? editLineStats(edit) : null);
  return stats.every((entry) => entry !== null)
    ? stats.reduce<FileLineStats>((total, entry) => ({ added: total.added + entry!.added, removed: total.removed + entry!.removed }), { added: 0, removed: 0 })
    : null;
}

export function writeLineCount(args: Record<string, unknown>): number | null {
  return !args.__truncated && typeof args.content === "string" ? textLines(args.content).length : null;
}
