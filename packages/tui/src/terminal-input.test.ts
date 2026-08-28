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

  it("keeps pasted newlines as text while treating a standalone return as submit", () => {
    expect(parseTerminalInput("first\nsecond").tokens).toEqual([
      { type: "text", value: "first" },
      { type: "text", value: " " },
      { type: "text", value: "second" },
    ]);
    expect(parseTerminalInput("\r").tokens).toEqual([{ type: "enter" }]);
  });
});
