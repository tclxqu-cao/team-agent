import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { handleNativeTerminalPaste, joinNativeTerminalSelection } from "./nativeTerminalTouch";

describe("native terminal selection text", () => {
  it("joins soft-wrapped commands while retaining actual line breaks", () => {
    const rows = [{ text: "echo hello ", wrapped: false }, { text: "world", wrapped: true }, { text: "$ next", wrapped: false }];
    expect(joinNativeTerminalSelection(rows, { row: 0, offset: 0 }, { row: 2, offset: 6 })).toBe("echo hello world\n$ next");
  });

  it("copies partial selections with Unicode and preserves blank lines", () => {
    const rows = [{ text: "$ 中文😀", wrapped: false }, { text: "", wrapped: false }, { text: "tail", wrapped: false }];
    expect(joinNativeTerminalSelection(rows, { row: 0, offset: 2 }, { row: 2, offset: 2 })).toBe("中文😀\n\nta");
    expect(joinNativeTerminalSelection(rows, { row: 0, offset: 2 }, { row: 0, offset: 4 })).toBe("中文");
  });
});

describe("native terminal paste", () => {
  const createEvent = (fields: Record<string, unknown>) => ({
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...fields,
  }) as unknown as ClipboardEvent & InputEvent;

  it("handles clipboard data once and prevents the browser's second insertion", () => {
    const textarea = { value: "old input" } as HTMLTextAreaElement;
    const paste = vi.fn();
    const event = createEvent({ type: "paste", clipboardData: { getData: () => "echo 中文\necho again" } });
    expect(handleNativeTerminalPaste(event, textarea, paste)).toBe(true);
    expect(paste.mock.calls).toEqual([["echo 中文\necho again"]]);
    expect(textarea.value).toBe("");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopImmediatePropagation).toHaveBeenCalledOnce();
  });

  it("keeps repeated intentional pastes rather than deduplicating by text or time", () => {
    const paste = vi.fn();
    const textarea = { value: "" } as HTMLTextAreaElement;
    for (let index = 0; index < 2; index++) {
      handleNativeTerminalPaste(createEvent({ type: "paste", clipboardData: { getData: () => "same" } }), textarea, paste);
    }
    expect(paste.mock.calls).toEqual([["same"], ["same"]]);
  });

  it("falls back from inaccessible paste data to Safari's insertFromPaste input", () => {
    const textarea = { value: "" } as HTMLTextAreaElement;
    const paste = vi.fn();
    const original = createEvent({ type: "paste", clipboardData: null });
    expect(handleNativeTerminalPaste(original, textarea, paste)).toBe(false);
    expect(original.preventDefault).not.toHaveBeenCalled();
    const before = createEvent({ type: "beforeinput", inputType: "insertFromPaste", data: null });
    expect(handleNativeTerminalPaste(before, textarea, paste)).toBe(false);
    textarea.value = "手机粘贴";
    const input = createEvent({ type: "input", inputType: "insertFromPaste", data: null });
    expect(handleNativeTerminalPaste(input, textarea, paste)).toBe(true);
    expect(paste.mock.calls).toEqual([["手机粘贴"]]);
    expect(textarea.value).toBe("");
  });

  it("uses beforeinput data when available and ignores normal keyboard or IME input", () => {
    const textarea = { value: "" } as HTMLTextAreaElement;
    const paste = vi.fn();
    expect(handleNativeTerminalPaste(createEvent({ type: "beforeinput", inputType: "insertFromPaste", data: "hello" }), textarea, paste)).toBe(true);
    for (const inputType of ["insertText", "insertCompositionText", "deleteContentBackward"]) {
      const event = createEvent({ type: "input", inputType, data: "中" });
      expect(handleNativeTerminalPaste(event, textarea, paste)).toBe(false);
      expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
    }
    expect(paste.mock.calls).toEqual([["hello"]]);
  });

  it("consumes an empty clipboard without sending input or submitting a command", () => {
    const paste = vi.fn();
    expect(handleNativeTerminalPaste(createEvent({ type: "paste", clipboardData: { getData: () => "" } }), { value: "" } as HTMLTextAreaElement, paste)).toBe(true);
    expect(paste).not.toHaveBeenCalled();
  });
});

describe("native terminal touch integration", () => {
  const pane = readFileSync(new URL("./TerminalPane.tsx", import.meta.url), "utf8");
  const adapter = readFileSync(new URL("./nativeTerminalTouch.ts", import.meta.url), "utf8");

  it("removes the permanent clipboard buttons and the manual paste dialog", () => {
    expect(pane).not.toContain("terminal-clipboard-tools");
    expect(pane).not.toContain("terminal-clipboard-panel");
    expect(pane).not.toContain("clipboard.readText");
    expect(pane).toContain("installNativeTerminalTouch(term");
  });

  it("protects native long presses and selection from capture, refocusing, and output redraws", () => {
    expect(pane).toContain("if (!nativeTouch) try { scrollSurface?.setPointerCapture");
    expect(pane).toContain("if (nativeTouch?.ownsTouch(event.target))");
    expect(pane).toContain("if (nativeTouchRef.current?.consumeClick()) return");
    expect(pane).toContain("acquireWrite(false, false)");
    expect(adapter).toContain("if (disposed || isHoldingText()) return");
    expect(adapter).toContain('ownerDocument.addEventListener("copy", copyEvent, true)');
    expect(adapter).toContain('ownerDocument.removeEventListener("copy", copyEvent, true)');
  });
});
