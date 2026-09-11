import { describe, expect, it } from "vitest";
import { shouldSuppressTouchScrollInput, terminalClipboardShortcut } from "./terminalInputPolicy";

describe("shouldSuppressTouchScrollInput", () => {
  it.each(["a", "l", "\x7f", "echo echo"])("allows repeated terminal data %j", (data) => {
    expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, true)).toBe(false);
    expect(shouldSuppressTouchScrollInput(data, true)).toBe(false);
  });

  it.each(["\x1b[A", "\x1b[B", "\x1b[5~", "\x1b[6~"])(
    "suppresses %j only during touch scrolling",
    (data) => {
      expect(shouldSuppressTouchScrollInput(data, true)).toBe(true);
      expect(shouldSuppressTouchScrollInput(data, false)).toBe(false);
    },
  );
});

describe("terminal clipboard shortcuts", () => {
  const event = { type: "keydown", key: "c", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false };

  it("keeps Ctrl+C as SIGINT unless text is selected", () => {
    expect(terminalClipboardShortcut(event, false)).toBeNull();
    expect(terminalClipboardShortcut(event, true)).toBe("copy");
  });

  it("supports explicit copy shortcuts and ignores keyup and Alt chords", () => {
    expect(terminalClipboardShortcut({ ...event, key: "C", shiftKey: true }, false)).toBe("copy");
    expect(terminalClipboardShortcut({ ...event, ctrlKey: false, metaKey: true }, false)).toBe("copy");
    expect(terminalClipboardShortcut({ ...event, type: "keyup" }, true)).toBeNull();
    expect(terminalClipboardShortcut({ ...event, altKey: true }, true)).toBeNull();
  });

  it("delegates paste shortcuts to the browser's native paste event", () => {
    expect(terminalClipboardShortcut({ ...event, key: "v" }, false)).toBe("paste");
    expect(terminalClipboardShortcut({ ...event, key: "V", shiftKey: true }, false)).toBe("paste");
    expect(terminalClipboardShortcut({ ...event, key: "v", ctrlKey: false, metaKey: true }, false)).toBe("paste");
    expect(terminalClipboardShortcut({ ...event, key: "v", ctrlKey: false }, false)).toBeNull();
  });
});
