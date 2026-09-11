import { describe, expect, it } from "vitest";
import { parseTerminalInput } from "./terminal-input.js";

describe("parseTerminalInput", () => {
  it("splits text and multiple cursor sequences from one terminal chunk", () => {
    expect(parseTerminalInput("/\u001b[B\u001bOA")).toEqual({
      tokens: [{ type: "text", value: "/" }, { type: "down" }, { type: "up" }],
      remainder: "",
    });
  });

  it("buffers fragmented escape sequences and flushes a standalone escape", () => {
    const first = parseTerminalInput("\u001b");
    expect(first).toEqual({ tokens: [], remainder: "\u001b" });
    expect(parseTerminalInput(first.remainder + "[B")).toEqual({ tokens: [{ type: "down" }], remainder: "" });
    expect(parseTerminalInput("\u001b", true)).toEqual({ tokens: [{ type: "escape" }], remainder: "" });
  });

  it("supports modified CSI and Kitty keyboard protocol keys", () => {
    expect(parseTerminalInput("\u001b[1;2A\u001b[57353;1u\u001b[27u\u001b[127u").tokens).toEqual([
      { type: "up" },
      { type: "down" },
      { type: "escape" },
      { type: "backspace" },
    ]);
  });

  it("keeps pasted newlines as literal line breaks while a standalone return submits", () => {
    expect(parseTerminalInput("first\nsecond").tokens).toEqual([
      { type: "text", value: "first" },
      { type: "text", value: "\n" },
      { type: "text", value: "second" },
    ]);
    expect(parseTerminalInput("\r").tokens).toEqual([{ type: "enter" }]);
  });

  it("maps Alt+Enter to a literal newline", () => {
    expect(parseTerminalInput("\u001b\r").tokens).toEqual([{ type: "text", value: "\n" }]);
    expect(parseTerminalInput("\u001b\n").tokens).toEqual([{ type: "text", value: "\n" }]);
  });

  it("recognises scrollback keys", () => {
    expect(parseTerminalInput("\u001b[5~\u001b[6~\u000f").tokens).toEqual([
      { type: "pageup" },
      { type: "pagedown" },
      { type: "ctrl_o" },
    ]);
  });

  it("recognises Emacs editing keys", () => {
    expect(parseTerminalInput("\u0001\u0005\u000b\u0015\u0017\u001bb\u001bf").tokens).toEqual([
      { type: "home" },
      { type: "end" },
      { type: "kill_end" },
      { type: "kill_start" },
      { type: "delete_word" },
      { type: "word_left" },
      { type: "word_right" },
    ]);
  });
});
