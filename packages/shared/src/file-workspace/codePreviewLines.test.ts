import { describe, expect, it } from "vitest";
import { codePreviewLines } from "./codePreviewLines";

describe("source preview line numbering", () => {
  it("keeps source lines stable across every possible chunk boundary", () => {
    const source = "first\r\n\r\n\t中文代码\nlast\n";
    for (let offset = 0; offset <= source.length; offset += 1) {
      const lines = codePreviewLines([source.slice(0, offset), "", source.slice(offset)]);
      expect(lines).toEqual(source.split("\n"));
      expect(lines.join("\n")).toBe(source);
    }
  });

  it("extends a partially loaded final line before numbering new lines", () => {
    expect(codePreviewLines(["first\npar"])).toEqual(["first", "par"]);
    expect(codePreviewLines(["first\npar", "tial\nnext"])).toEqual(["first", "partial", "next"]);
  });

  it("retains empty files, blank lines and final newline positions", () => {
    expect(codePreviewLines([])).toEqual([""]);
    expect(codePreviewLines([""])).toEqual([""]);
    expect(codePreviewLines(["\n", "\n"])).toEqual(["", "", ""]);
    expect(codePreviewLines(["one"])).toEqual(["one"]);
  });
});
