import { describe, expect, it } from "vitest";
import { highlightCode, mergeSegments } from "./syntax-highlight.js";
import { TUI_THEME } from "./theme.js";

describe("highlightCode", () => {
  it("colors keywords, strings, comments, and numbers in C-like code", () => {
    const segments = highlightCode('const n = 1; // count\nreturn "hi";', "ts");
    const colored = (text: string) => segments.find((segment) => segment.text === text)?.color;
    expect(colored("const")).toBe(TUI_THEME.spark);
    expect(colored("1")).toBe(TUI_THEME.progress);
    expect(colored("// count")).toBe(TUI_THEME.muted);
    expect(colored('"hi"')).toBe(TUI_THEME.user);
    expect(segments.map((segment) => segment.text).join("")).toBe('const n = 1; // count\nreturn "hi";');
  });

  it("supports hash comments for shell and python", () => {
    for (const lang of ["bash", "py"]) {
      const segments = highlightCode("echo hi # comment", lang);
      expect(segments.find((segment) => segment.text.startsWith("#"))?.color).toBe(TUI_THEME.muted);
    }
  });

  it("keeps unterminated strings bounded to one line", () => {
    const segments = highlightCode('call("open\ncode', "ts");
    const joined = segments.map((segment) => segment.text).join("");
    expect(joined).toContain('call("open');
    expect(joined).toContain("code");
  });

  it("skips highlighting for very large blocks", () => {
    const huge = "x".repeat(25_000);
    expect(highlightCode(huge, "ts")).toEqual([{ text: huge }]);
  });

  it("merges adjacent same-color segments", () => {
    expect(mergeSegments([
      { text: "a", color: "#111111" },
      { text: "b", color: "#111111" },
      { text: "c" },
    ])).toEqual([
      { text: "ab", color: "#111111" },
      { text: "c", color: undefined },
    ]);
  });
});
