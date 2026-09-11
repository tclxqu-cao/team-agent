import { describe, expect, it } from "vitest";
import { applyVimKey, initialVimState, type VimState } from "./vim.js";
import type { TerminalInputToken } from "./terminal-input.js";

function key(value: string): TerminalInputToken {
  return { type: "text", value };
}

function type(state: VimState, text: string): { state: VimState; input: string; cursor: number } {
  let current = { state, input: "", cursor: 0 };
  for (const ch of text) {
    const result = applyVimKey(current.state, { input: current.input, cursor: current.cursor }, key(ch));
    if (!result.consumed) {
      // In insert mode typing flows through the composer: emulate it.
      current = {
        state: result.state,
        input: current.input.slice(0, current.cursor) + ch + current.input.slice(current.cursor),
        cursor: current.cursor + 1,
      };
    } else {
      current = { state: result.state, input: result.buffer.input, cursor: result.buffer.cursor };
    }
  }
  return current;
}

describe("vim mode", () => {
  it("starts in normal mode and enters insert with i, returns with Esc", () => {
    let state = initialVimState();
    expect(state.mode).toBe("normal");
    const enter = applyVimKey(state, { input: "abc", cursor: 0 }, key("i"));
    expect(enter.consumed).toBe(true);
    expect(enter.state.mode).toBe("insert");
    const esc = applyVimKey(enter.state, { input: "abc", cursor: 1 }, { type: "escape" });
    expect(esc.consumed).toBe(true);
    expect(esc.state.mode).toBe("normal");
  });

  it("moves within lines and by words in normal mode", () => {
    let state = initialVimState();
    const buffer = { input: "foo bar", cursor: 0 };
    const l = applyVimKey(state, buffer, key("l"));
    expect(l.buffer.cursor).toBe(1);
    const w = applyVimKey(l.state, l.buffer, key("w"));
    expect(w.buffer.cursor).toBe(4);
    const b = applyVimKey(w.state, w.buffer, key("b"));
    expect(b.buffer.cursor).toBe(0);
    const dollar = applyVimKey(b.state, b.buffer, key("$"));
    expect(dollar.buffer.cursor).toBe(7);
    const zero = applyVimKey(dollar.state, dollar.buffer, key("0"));
    expect(zero.buffer.cursor).toBe(0);
  });

  it("edits with x, D, and undoes with u", () => {
    let state = initialVimState();
    const x = applyVimKey(state, { input: "abc", cursor: 0 }, key("x"));
    expect(x.buffer).toEqual({ input: "bc", cursor: 0 });
    const d = applyVimKey(x.state, x.buffer, key("D"));
    expect(d.buffer).toEqual({ input: "", cursor: 0 });
    const u = applyVimKey(d.state, d.buffer, key("u"));
    expect(u.buffer.input).toBe("bc");
    const u2 = applyVimKey(u.state, u.buffer, key("u"));
    expect(u2.buffer.input).toBe("abc");
    const u3 = applyVimKey(u2.state, u2.buffer, key("u"));
    expect(u3.bell).toBe(true);
  });

  it("deletes and yanks lines with dd/yy and pastes with p", () => {
    let state = initialVimState();
    const dd = applyVimKey(state, { input: "one\ntwo\nthree", cursor: 5 }, key("d"));
    expect(dd.state.pending).toBe("d");
    const d2 = applyVimKey(dd.state, dd.buffer, key("d"));
    expect(d2.buffer.input).toBe("one\nthree");
    expect(d2.state.register).toBe("two\n");
    const p = applyVimKey(d2.state, d2.buffer, key("p"));
    expect(p.buffer.input).toBe("one\nthree\ntwo\n");
  });

  it("opens insert mode with a/A/o and types through the composer", () => {
    const state = initialVimState();
    const a = applyVimKey(state, { input: "ab", cursor: 0 }, key("a"));
    expect(a.state.mode).toBe("insert");
    expect(a.buffer.cursor).toBe(1);
    const o = applyVimKey(state, { input: "one\ntwo", cursor: 1 }, key("o"));
    expect(o.state.mode).toBe("insert");
    expect(o.buffer.input.startsWith("one\n")).toBe(true);
  });

  it("keeps Enter unconsumed for submit even in normal mode", () => {
    const result = applyVimKey(initialVimState(), { input: "hi", cursor: 2 }, { type: "enter" });
    expect(result.consumed).toBe(false);
  });

  it("lets slash fall through in normal mode so commands stay reachable", () => {
    const result = applyVimKey(initialVimState(), { input: "", cursor: 0 }, key("/"));
    expect(result.consumed).toBe(false);
    expect(result.buffer.input).toBe("");
  });

  it("bells on unknown commands and multi-char paste in normal mode", () => {
    const state = initialVimState();
    const unknown = applyVimKey(state, { input: "ab", cursor: 0 }, key("Z"));
    expect(unknown.bell).toBe(true);
    const paste = applyVimKey(state, { input: "ab", cursor: 0 }, { type: "text", value: "pasted" });
    expect(paste.bell).toBe(true);
  });

  it("types multi-word insert text through insert mode", () => {
    const state = initialVimState();
    const started = applyVimKey(state, { input: "", cursor: 0 }, key("i"));
    const typed = type(started.state, "hello world");
    expect(typed.input).toBe("hello world");
    expect(typed.cursor).toBe(11);
    const esc = applyVimKey(typed.state, { input: typed.input, cursor: typed.cursor }, { type: "escape" });
    expect(esc.state.mode).toBe("normal");
  });
});
