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

  it("fills a prediction with plain Tab and leaves normal focus navigation and IME alone", () => {
    const state = { running: false, pickerOpen: false, predictionVisible: true };
    expect(composerKeyAction({ key: "Tab", nativeEvent: {} }, state)).toBe("accept-prediction");
    expect(composerKeyAction({ key: "Tab", shiftKey: true, nativeEvent: {} }, state)).toBeNull();
    expect(composerKeyAction({ key: "Tab", nativeEvent: {} }, { ...state, predictionVisible: false })).toBeNull();
    expect(composerKeyAction({ key: "Tab", nativeEvent: { isComposing: true } }, state)).toBeNull();
    expect(composerKeyAction({ key: "Escape", nativeEvent: {} }, state)).toBe("dismiss-prediction");
    expect(composerKeyAction({ key: "Tab", nativeEvent: {} }, { ...state, pickerOpen: true, pickerOptions: 2 })).toBe("accept-option");
  });
});
