import { describe, expect, it } from "vitest";
import { fileChangeLineStats, summarizeFileChanges, textLines, textLineStats } from "./file-change-summary.js";

describe("file change line counts", () => {
  it("counts raw Codex additions and deletions, including lines starting with diff markers", () => {
    expect(fileChangeLineStats({ kind: { type: "add" }, diff: "+literal\n---literal\n\n" })).toEqual({ added: 3, removed: 0 });
    expect(fileChangeLineStats({ kind: "delete", diff: "one\r\ntwo\r\n" })).toEqual({ added: 0, removed: 2 });
    expect(textLines("")).toEqual([]);
    expect(textLines("\n")).toEqual([""]);
    expect(textLines("one")).toEqual(["one"]);
  });

  it("counts unified diff hunks and excludes headers, context, and no-newline markers", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n same\n-old\n+++literal code\n\\ No newline at end of file\n@@ -8,1 +8,2 @@\n-other\n+new\n+extra\n";
    expect(fileChangeLineStats({ kind: { type: "update" }, diff })).toEqual({ added: 3, removed: 2 });
    expect(fileChangeLineStats({ kind: { type: "update" }, diff: "Moved to: other.ts" })).toBeNull();
  });

  it("keeps compact counts usable after diff content is omitted", () => {
    expect(fileChangeLineStats({ kind: { type: "update" }, lineStats: { added: 6, removed: 6 } })).toEqual({ added: 6, removed: 6 });
    expect(fileChangeLineStats({ lineStats: { added: -1, removed: 2 } })).toBeNull();
  });

  it("sums mixed files only when every file has reliable counts", () => {
    expect(summarizeFileChanges([
      { kind: { type: "add" }, diff: "one\ntwo\n" },
      { kind: { type: "update" }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
      { kind: { type: "delete" }, diff: "gone\n" },
    ])).toEqual({ operation: "update", fileCount: 3, lineStats: { added: 3, removed: 2 } });
    expect(summarizeFileChanges([{ kind: { type: "add" } }])).toEqual({ operation: "add", fileCount: 1, lineStats: null });
  });

  it("excludes unchanged context and handles pure insertions, deletions, and trailing newlines", () => {
    expect(textLineStats("same\nold\ntail\n", "same\nnew\ntail\n")).toEqual({ added: 1, removed: 1 });
    expect(textLineStats("", "a\nb\n")).toEqual({ added: 2, removed: 0 });
    expect(textLineStats("a\nb\n", "")).toEqual({ added: 0, removed: 2 });
    expect(textLineStats("a\n", "a")).toEqual({ added: 0, removed: 0 });
  });

  it("counts a small edit inside a large file without the old all-added fallback", () => {
    const before = Array.from({ length: 1200 }, (_, i) => `line ${i}`).join("\n");
    expect(textLineStats(before, before.replace("line 600", "updated"))).toEqual({ added: 1, removed: 1 });
    expect(textLineStats("old\n".repeat(500), "new\n".repeat(500))).toBeNull();
  });
});
