import { describe, expect, it } from "vitest";
import { completeComposerSlashToken, readComposerSlashToken } from "./composer-slash-token";

describe("composer slash token", () => {
  it.each([
    ["/| 后面的文字", "/wiki-query 后面的文字"],
    ["前面的文字 /| 后面的文字", "前面的文字 /wiki-query 后面的文字"],
    ["前面的文字 /wiki|", "前面的文字 /wiki-query "],
    ["前面的文字 /wiki|-query  后面的文字", "前面的文字 /wiki-query  后面的文字"],
    ["前面的文字\n/| 后面的文字", "前面的文字\n/wiki-query 后面的文字"],
  ])("completes the token at the caret in %s", (marked, expected) => {
    const caret = marked.indexOf("|");
    const value = marked.replace("|", "");
    const token = readComposerSlashToken(value, caret);
    expect(token?.query).toBe(value.slice(value.lastIndexOf("/", caret - 1) + 1, caret));
    const result = completeComposerSlashToken(value, token!, "wiki-query");
    expect(result).toEqual({ value: expected, caret: expected.indexOf("/wiki-query") + "/wiki-query ".length });
  });

  it.each(["文字/| 后文", "/|后文", "https://example.org/wiki|", "/wiki|/topic", "/wiki 后文|"])(
    "ignores a slash outside a command token in %s",
    (marked) => {
      expect(readComposerSlashToken(marked.replace("|", ""), marked.indexOf("|"))).toBeNull();
    },
  );

  it("preserves the native skill sigil and surrounding draft text", () => {
    const value = "先用 $front 检查";
    const token = readComposerSlashToken(value, "先用 $front".length, "$");
    expect(completeComposerSlashToken(value, token!, "frontend-design").value).toBe("先用 $frontend-design 检查");
  });
});
