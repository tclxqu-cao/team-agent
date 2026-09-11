import { describe, expect, it } from "vitest";
import { backspace, deleteWordBack, insertText, killToEnd, killToStart, moveDown, moveUp, onFirstLine, onLastLine, renderLines, wordLeft, wordRight } from "./text-editor.js";

describe("text-editor multi-line helpers", () => {
  it("moves the caret between visual lines keeping the column", () => {
    const input = "abcdef\nab\nabcdefgh";
    expect(moveUp(input, 9)).toBe(2);
    expect(moveUp(input, 3)).toBeNull();
    expect(moveUp(input, 10)).toBe(7);
    expect(moveUp(input, 0)).toBeNull();
    expect(moveDown(input, 1)).toBe(8);
    expect(moveDown(input, 16)).toBeNull();
    expect(onFirstLine(input, 3)).toBe(true);
    expect(onFirstLine(input, 7)).toBe(false);
    expect(onLastLine(input, 9)).toBe(false);
    expect(onLastLine(input, 16)).toBe(true);
  });

  it("clamps the column to the target line length", () => {
    const input = "abcdef\nab";
    expect(moveDown(input, 6)).toBe(9);
    expect(moveUp(input, 8)).toBe(1);
  });

  it("joins lines when backspacing across a newline", () => {
    expect(backspace("abc\ndef", 4)).toEqual({ input: "abcdef", cursor: 3 });
    expect(backspace("abc", 0)).toBeNull();
    expect(insertText("ab", 1, "x\ny")).toEqual({ input: "ax\nyb", cursor: 4 });
  });

  it("moves by words skipping whitespace", () => {
    const input = "foo bar  baz\nqux";
    expect(wordLeft(input, 4)).toBe(0);
    expect(wordLeft(input, 7)).toBe(4);
    expect(wordLeft(input, 13)).toBe(9);
    expect(wordLeft(input, 0)).toBe(0);
    expect(wordRight(input, 0)).toBe(3);
    expect(wordRight(input, 3)).toBe(7);
    expect(wordRight(input, 10)).toBe(12);
    expect(wordRight(input, 12)).toBe(16);
  });

  it("deletes the word before the caret", () => {
    expect(deleteWordBack("foo bar ", 8)).toEqual({ input: "foo ", cursor: 4 });
    // Ctrl+W on pure whitespace deletes the whitespace run, like bash.
    expect(deleteWordBack("   ", 3)).toEqual({ input: "", cursor: 0 });
    expect(deleteWordBack("abc", 0)).toBeNull();
  });

  it("kills to the line end or start", () => {
    expect(killToEnd("abc\ndef", 1)).toEqual({ input: "a\ndef", cursor: 1 });
    expect(killToEnd("abc\ndef", 3)).toEqual({ input: "abcdef", cursor: 3 });
    expect(killToEnd("abc", 3)).toEqual({ input: "abc", cursor: 3 });
    expect(killToStart("abc\ndef", 7)).toEqual({ input: "abc\n", cursor: 4 });
    expect(killToStart("abc", 1)).toEqual({ input: "bc", cursor: 0 });
  });

  it("tags exactly the visual line holding the caret", () => {
    expect(renderLines("ab\ncd", 3)).toEqual([
      { text: "ab", cursorOffset: null },
      { text: "cd", cursorOffset: 0 },
    ]);
    expect(renderLines("ab", 2)).toEqual([{ text: "ab", cursorOffset: 2 }]);
    expect(renderLines("", 0)).toEqual([{ text: "", cursorOffset: 0 }]);
    expect(renderLines("ab\n\ncd", 3)).toEqual([
      { text: "ab", cursorOffset: null },
      { text: "", cursorOffset: 0 },
      { text: "cd", cursorOffset: null },
    ]);
  });
});
