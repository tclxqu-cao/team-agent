import { describe, expect, it } from "vitest";
import { editLineStats, multiEditLineStats, patchSummary, writeLineCount } from "./file-tool-presentation";

describe("file tool presentation", () => {
  it("recovers old bounded patch counts from the existing tool result", () => {
    const args = { __truncated: true, changes: [{ path: "a.ts", kind: { type: "add" } }] };
    expect(patchSummary(args)?.lineStats).toBeNull();
    expect(patchSummary(args, JSON.stringify([{ path: "a.ts", kind: { type: "add" }, diff: "line\n".repeat(301) }])))
      .toEqual({ operation: "add", fileCount: 1, lineStats: { added: 301, removed: 0 } });
    expect(patchSummary(args, "operation failed")?.lineStats).toBeNull();
  });

  it("avoids guessing replacement counts for truncated or replace-all edits", () => {
    expect(editLineStats({ old_string: "a", new_string: "b", replace_all: true })).toBeNull();
    expect(editLineStats({ old_string: "a", new_string: "b", __truncated: true })).toBeNull();
    expect(editLineStats({ old_string: "a\n", new_string: "" })).toEqual({ added: 0, removed: 1 });
  });

  it("sums individual edits and counts file lines without an extra trailing empty line", () => {
    expect(multiEditLineStats({ edits: [{ old_string: "a", new_string: "b" }, { old_string: "", new_string: "c\nd\n" }] }))
      .toEqual({ added: 3, removed: 1 });
    expect(writeLineCount({ content: "one\ntwo\n" })).toBe(2);
    expect(writeLineCount({ content: "one", __truncated: true })).toBeNull();
  });
});
