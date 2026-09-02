import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

function stubSelectionCopy(result = true) {
  const textarea = {
    value: "",
    style: {},
    setAttribute: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    setSelectionRange: vi.fn(),
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  const execCommand = vi.fn(() => result);

  vi.stubGlobal("document", {
    body: { appendChild },
    createElement: vi.fn(() => textarea),
    execCommand,
  });

  return { textarea, appendChild, execCommand };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("copyTextToClipboard", () => {
  it("uses the Clipboard API in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("isSecureContext", true);

    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("copies synchronously through a selection on insecure LAN pages", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("isSecureContext", false);
    const fallback = stubSelectionCopy();

    await expect(copyTextToClipboard("手机消息")).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(fallback.textarea.value).toBe("手机消息");
    expect(fallback.appendChild).toHaveBeenCalledWith(fallback.textarea);
    expect(fallback.textarea.select).toHaveBeenCalledOnce();
    expect(fallback.execCommand).toHaveBeenCalledWith("copy");
    expect(fallback.textarea.remove).toHaveBeenCalledOnce();
  });

  it("falls back when Clipboard API permission is rejected", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.stubGlobal("isSecureContext", true);
    const fallback = stubSelectionCopy();

    await expect(copyTextToClipboard("fallback")).resolves.toBe(true);
    expect(fallback.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither copy mechanism is available", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);

    await expect(copyTextToClipboard("unavailable")).resolves.toBe(false);
  });
});
