import { describe, expect, it } from "vitest";
import { composerKeyAction } from "./composer-keyboard";

describe("composer keyboard", () => {
  const running = { running: true, pickerOpen: false };

  it.each(["Escape", "Enter"])("leaves IME %s to candidate selection", (key) => {
    expect(composerKeyAction({ key, nativeEvent: { isComposing: true } }, running)).toBeNull();
    expect(composerKeyAction({ key, nativeEvent: { keyCode: 229 } }, running)).toBeNull();
  });

  it("does not repeat a stop or override an already handled key", () => {
    expect(composerKeyAction({ key: "Escape", repeat: true, nativeEvent: {} }, running)).toBeNull();
    expect(composerKeyAction({ key: "Escape", defaultPrevented: true, nativeEvent: {} }, running)).toBeNull();
  });

  it("dismisses suggestions before stopping and keeps ordinary shortcuts", () => {
    expect(composerKeyAction({ key: "Escape", nativeEvent: {} }, { ...running, pickerOpen: true })).toBe("dismiss-picker");
    expect(composerKeyAction({ key: "Escape", nativeEvent: {} }, running)).toBe("abort");
    expect(composerKeyAction({ key: "Escape", nativeEvent: {} }, { ...running, running: false })).toBeNull();
    expect(composerKeyAction({ key: "Enter", nativeEvent: {} }, running)).toBe("send");
    expect(composerKeyAction({ key: "Enter", shiftKey: true, nativeEvent: {} }, running)).toBeNull();
  });
});
