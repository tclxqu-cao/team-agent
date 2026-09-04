import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./fileDiff";

describe("parseUnifiedDiff", () => {
  it("returns no rows for an unchanged file", () => {
    expect(parseUnifiedDiff("")).toEqual({ rows: [], added: 0, removed: 0 });
  });

  it("tracks old and new line numbers across a replacement", () => {
    const result = parseUnifiedDiff([
      "diff --git a/note.txt b/note.txt",
      "--- a/note.txt",
      "+++ b/note.txt",
      "@@ -3,4 +3,4 @@",
      " same",
      "-before",
      "+after",
      " tail",
    ].join("\n"));

    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.rows).toEqual([
      { kind: "hunk", text: "@@ -3,4 +3,4 @@", oldLine: null, newLine: null },
      { kind: "context", text: "same", oldLine: 3, newLine: 3 },
      { kind: "removed", text: "before", oldLine: 4, newLine: null },
      { kind: "added", text: "after", oldLine: null, newLine: 4 },
      { kind: "context", text: "tail", oldLine: 5, newLine: 5 },
    ]);
  });

  it("keeps file metadata and no-newline notes without counting them", () => {
    const result = parseUnifiedDiff([
      "diff --git a/run.sh b/run.sh",
      "old mode 100644",
      "new mode 100755",
      "@@ -1 +1 @@",
      "-echo old",
      "+echo new",
      "\\ No newline at end of file",
    ].join("\n"));

    expect(result.rows.slice(0, 2).map((row) => row.kind)).toEqual(["meta", "meta"]);
    expect(result.rows.at(-1)).toMatchObject({ kind: "note", oldLine: null, newLine: null });
    expect({ added: result.added, removed: result.removed }).toEqual({ added: 1, removed: 1 });
  });
});
