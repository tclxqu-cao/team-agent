import { describe, expect, it } from "vitest";
import { ScrollbackBuffer, TerminalSession } from "./TerminalSession.js";

const utf8 = (s: string) => new TextEncoder().encode(s);

describe("ScrollbackBuffer", () => {
  it("retains appended chunks in order", () => {
    const buf = new ScrollbackBuffer(1000);
    buf.append(utf8("hello "));
    buf.append(utf8("world"));
    expect(new TextDecoder().decode(buf.snapshot())).toBe("hello world");
  });

  it("trims oldest chunks beyond maxBytes", () => {
    const buf = new ScrollbackBuffer(10);
    buf.append(utf8("aaaaaaaaaa")); // 10 bytes
    buf.append(utf8("bb")); // pushes head out
    expect(buf.byteLength).toBeLessThanOrEqual(10);
    const text = new TextDecoder().decode(buf.snapshot());
    expect(text.endsWith("bb")).toBe(true);
    expect(text).not.toContain("aaaa");
  });

  it("hard-trims a single oversized chunk", () => {
    const buf = new ScrollbackBuffer(4);
    buf.append(utf8("abcdefgh"));
    expect(buf.byteLength).toBe(4);
    expect(new TextDecoder().decode(buf.snapshot())).toBe("efgh");
  });
});

describe("TerminalSession", () => {
  it("tracks size with bounds clamping", () => {
    const session = new TerminalSession("t1");
    expect(session.size).toEqual({ cols: 80, rows: 24 });
    session.resize(-1, 99999);
    expect(session.size).toEqual({ cols: 2, rows: 300 });
    session.resize(120.7, 40.2);
    expect(session.size).toEqual({ cols: 120, rows: 40 });
  });

  it("readSince returns only new output and null when up to date", () => {
    const session = new TerminalSession("t1");
    session.write(utf8("abc"));
    expect(session.readSince(0)).toEqual(utf8("abc"));
    expect(session.readSince(3)).toBeNull();
    session.write(utf8("def"));
    expect(session.readSince(3)).toEqual(utf8("def"));
  });

  it("readSince falls back to full replay for unknown cursor", () => {
    const session = new TerminalSession("t1");
    session.write(utf8("abcdef"));
    // cursor beyond buffer (already trimmed or bogus client) → full snapshot
    expect(session.readSince(99)).toEqual(utf8("abcdef"));
    expect(session.readSince(-5)).toEqual(utf8("abcdef"));
  });

  it("replays trimmed scrollback after capacity overflow", () => {
    const session = new TerminalSession("t1", { maxBufferBytes: 6 });
    session.write(utf8("abcdefgh")); // buffer keeps "cdefgh"
    const replay = session.readSince(0);
    expect(replay).not.toBeNull();
    expect(new TextDecoder().decode(replay!)).toBe("cdefgh");
  });
});
