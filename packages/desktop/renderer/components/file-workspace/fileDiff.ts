export type FileDiffRowKind = "meta" | "hunk" | "context" | "added" | "removed" | "note";

export interface FileDiffRow {
  kind: FileDiffRowKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
export interface ParsedFileDiff {
  rows: FileDiffRow[];
  added: number;
  removed: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(patch: string): ParsedFileDiff {
  if (!patch.trim()) return { rows: [], added: 0, removed: 0 };
  const rows: FileDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let insideHunk = false;
  let added = 0;
  let removed = 0;

  for (const line of patch.replace(/\n$/, "").split("\n")) {
    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      insideHunk = true;
      rows.push({ kind: "hunk", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (!insideHunk) {
      if (!line.startsWith("diff --git ") && !line.startsWith("index ") && !line.startsWith("--- ") && !line.startsWith("+++ ")) {
        rows.push({ kind: "meta", text: line, oldLine: null, newLine: null });
      }
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "added", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      added += 1;
    } else if (line.startsWith("-")) {
      rows.push({ kind: "removed", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      removed += 1;
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", text: line.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else {
      rows.push({ kind: "note", text: line, oldLine: null, newLine: null });
    }
  }

  return { rows, added, removed };
}
