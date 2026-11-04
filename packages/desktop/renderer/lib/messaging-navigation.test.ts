import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openShellMessaging } from "./messaging-navigation";

function setup(href = "http://100.121.10.115:3000/web?keep=1#tabs") {
  let opened = false;
  let changed = () => {};
  const disconnect = vi.fn();
  const parent = {
    postMessage: vi.fn(),
    document: { body: {}, querySelector: vi.fn(() => opened ? {} : null) },
    location: { href, assign: vi.fn() },
    history: { state: null, replaceState: vi.fn() },
  };
  vi.stubGlobal("window", { parent, location: { origin: "http://100.121.10.115:3000" } });
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { changed = callback; }
    observe() {}
    disconnect = disconnect;
  });
  return { parent, disconnect, showTab() { opened = true; changed(); } };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("messaging navigation across shell updates", () => {
  it("confirms the selected shell tab and coalesces repeated taps", async () => {
    const page = setup();
    const opened = openShellMessaging();
    expect(openShellMessaging()).toBe(opened);
    expect(page.parent.postMessage).toHaveBeenCalledTimes(1);
    page.showTab();
    await opened;
    await vi.advanceTimersByTimeAsync(2000);
    expect(page.parent.location.assign).not.toHaveBeenCalled();
    expect(page.disconnect).toHaveBeenCalledOnce();
  });

  it("consumes a pending tab request without requiring a new shell protocol", async () => {
    const page = setup("http://100.121.10.115:3000/web?openTab=messaging&keep=1");
    const opened = openShellMessaging();
    page.showTab(); await opened;
    expect(page.parent.history.replaceState).toHaveBeenCalledWith(null, "", "http://100.121.10.115:3000/web?keep=1");
    expect(page.parent.location.assign).not.toHaveBeenCalled();
  });

  it("reloads an old shell with the requested tab after the request is ignored", async () => {
    const page = setup();
    const opened = openShellMessaging();
    await vi.advanceTimersByTimeAsync(1500);
    await opened;
    expect(page.parent.location.assign).toHaveBeenCalledWith("http://100.121.10.115:3000/web?keep=1&openTab=messaging#tabs");
    expect(page.disconnect).toHaveBeenCalledOnce();
  });

  it("surfaces a navigation failure instead of silently dropping a click", async () => {
    const page = setup();
    page.parent.location.assign.mockImplementation(() => { throw new Error("navigation blocked"); });
    const opened = expect(openShellMessaging()).rejects.toThrow("消息接入未打开");
    await vi.advanceTimersByTimeAsync(1500);
    await opened;
  });
});
