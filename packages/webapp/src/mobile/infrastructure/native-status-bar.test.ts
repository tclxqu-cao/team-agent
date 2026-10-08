import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => "android"),
  overlay: vi.fn(async () => {}),
  background: vi.fn(async (_options: { color: string }) => {}),
  style: vi.fn(async (_options: { style: string }) => {}),
}));
vi.mock("@capacitor/core", () => ({ Capacitor: { getPlatform: mocks.platform } }));
vi.mock("@capacitor/status-bar", () => ({
  StatusBar: { setOverlaysWebView: mocks.overlay, setBackgroundColor: mocks.background, setStyle: mocks.style },
  Style: { Light: "LIGHT", Dark: "DARK" },
}));
vi.mock("@desktop/renderer/stores/uiStore", () => ({
  useUIStore: { getState: () => ({ skin: "pearl" }) },
}));
import { installNativeStatusBarBridge, statusBarAppearance } from "./native-status-bar";

let color: string;
let mutation: () => void;
let visibility: () => void;
let focus: () => void;
let hidden: boolean;
const disconnect = vi.fn();
const removeDocumentListener = vi.fn();
const removeWindowListener = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockReturnValue("android");
  mocks.background.mockResolvedValue(undefined);
  color = "#f5f6fa";
  hidden = false;
  vi.stubGlobal("document", {
    documentElement: { dataset: {} },
    get hidden() { return hidden; },
    addEventListener: (_type: string, listener: () => void) => { visibility = listener; },
    removeEventListener: removeDocumentListener,
  });
  vi.stubGlobal("window", {
    addEventListener: (_type: string, listener: () => void) => { focus = listener; },
    removeEventListener: removeWindowListener,
  });
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => color }));
  vi.stubGlobal("MutationObserver", class {
    constructor(listener: () => void) { mutation = listener; }
    observe() {}
    disconnect = disconnect;
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("native status bar skin bridge", () => {
  it("uses dark icons for light surfaces and light icons for dark surfaces", () => {
    expect(statusBarAppearance("#ffffff")).toEqual({ color: "#ffffff", style: "LIGHT" });
    expect(statusBarAppearance("#0d1626")).toEqual({ color: "#0d1626", style: "DARK" });
    expect(statusBarAppearance("#191d24")).toEqual({ color: "#191d24", style: "DARK" });
    expect(statusBarAppearance("transparent")).toBeNull();
  });

  it("applies the persisted startup skin and follows rendered theme changes", async () => {
    const dispose = installNativeStatusBarBridge();
    await flush();
    expect(document.documentElement.dataset.skin).toBe("pearl");
    expect(mocks.overlay).toHaveBeenCalledWith({ overlay: false });
    expect(mocks.background).toHaveBeenLastCalledWith({ color: "#f5f6fa" });
    color = "#050a14";
    mutation();
    await flush();
    expect(mocks.background).toHaveBeenLastCalledWith({ color });
    expect(mocks.style).toHaveBeenLastCalledWith({ style: "DARK" });
    dispose();
  });

  it("serializes delayed native calls so the final skin wins", async () => {
    let release: () => void = () => {};
    mocks.background.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; }));
    const dispose = installNativeStatusBarBridge();
    await flush();
    color = "#0f1115";
    mutation();
    await flush();
    expect(mocks.background).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(mocks.background).toHaveBeenLastCalledWith({ color });
    expect(mocks.style).toHaveBeenLastCalledWith({ style: "DARK" });
    dispose();
  });

  it("restores the current colors after returning from a native activity", async () => {
    const dispose = installNativeStatusBarBridge();
    await flush();
    mocks.background.mockClear();
    hidden = true;
    visibility();
    await flush();
    expect(mocks.background).not.toHaveBeenCalled();
    hidden = false;
    visibility();
    focus();
    await flush();
    expect(mocks.background).toHaveBeenLastCalledWith({ color });
    dispose();
  });

  it("recovers from a plugin failure without blocking later theme changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.background.mockRejectedValueOnce(new Error("native error"));
    const dispose = installNativeStatusBarBridge();
    await flush();
    color = "#050a14";
    mutation();
    await flush();
    expect(mocks.style).toHaveBeenLastCalledWith({ style: "DARK" });
    dispose();
    warn.mockRestore();
  });

  it("leaves browser pages alone and disconnects listeners on disposal", async () => {
    mocks.platform.mockReturnValue("web");
    installNativeStatusBarBridge()();
    await flush();
    expect(mocks.overlay).not.toHaveBeenCalled();
    mocks.platform.mockReturnValue("android");
    const dispose = installNativeStatusBarBridge();
    await flush();
    dispose();
    expect(disconnect).toHaveBeenCalled();
    expect(removeDocumentListener).toHaveBeenCalled();
    expect(removeWindowListener).toHaveBeenCalled();
  });
});
