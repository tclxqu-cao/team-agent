import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_LAYOUT_MESSAGE } from "../../../core/src/domain/web-console/navigation-layout";

const mocks = vi.hoisted(() => ({ navigationLayout: "agent-rail", setNavigationLayout: vi.fn(), rehydrate: vi.fn() }));
vi.mock("@desktop/renderer/stores/uiStore", () => ({ useUIStore: {
  getState: () => mocks,
  persist: { rehydrate: mocks.rehydrate, getOptions: () => ({ name: "agent-ui-prefs" }) },
} }));
import { installWebShellNavigationBridge } from "./web-shell-navigation";

function setup(embedded = true) {
  const parent = {};
  const callbacks = new Map<string, Set<(event: unknown) => void>>();
  const win = {
    parent: parent as unknown,
    location: { origin: "https://agent.test" },
    localStorage: {},
    addEventListener: (type: string, callback: (event: unknown) => void) => {
      if (!callbacks.has(type)) callbacks.set(type, new Set());
      callbacks.get(type)!.add(callback);
    },
    removeEventListener: (type: string, callback: (event: unknown) => void) => callbacks.get(type)?.delete(callback),
  };
  if (!embedded) win.parent = win;
  const dataset: Record<string, string> = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { body: { dataset } });
  return {
    parent, dataset,
    listenerCount: () => [...callbacks.values()].reduce((count, listeners) => count + listeners.size, 0),
    send(data: unknown, source: unknown = parent, origin = win.location.origin) { callbacks.get("message")?.forEach(callback => callback({ data, source, origin })); },
    storage(key: string | null, storageArea: unknown = win.localStorage) { callbacks.get("storage")?.forEach(callback => callback({ key, storageArea })); },
  };
}

beforeEach(() => {
  mocks.navigationLayout = "agent-rail";
  mocks.setNavigationLayout.mockImplementation((layout: string) => { mocks.navigationLayout = layout; });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("web shell navigation bridge", () => {
  it("does not hide the only layout button in standalone or PWA pages", () => {
    const page = setup(false);
    const cleanup = installWebShellNavigationBridge();
    expect(page.listenerCount()).toBe(0);
    expect(page.dataset.webShellEmbedded).toBeUndefined();
    cleanup();
  });

  it("applies validated parent choices and removes its listener and embedded marker", () => {
    const page = setup();
    const cleanup = installWebShellNavigationBridge();
    expect(page.dataset.webShellEmbedded).toBeUndefined();
    page.send({ type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "classic" });
    expect(page.dataset.webShellEmbedded).toBe("1");
    page.send({ type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "agent-rail" });
    page.send({ type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "all-sessions" });
    expect(mocks.setNavigationLayout.mock.calls).toEqual([["classic"], ["agent-rail"], ["all-sessions"]]);
    cleanup();
    expect(page.listenerCount()).toBe(0);
    expect(page.dataset.webShellEmbedded).toBeUndefined();
  });

  it("does not persist an echoed layout that is already selected", () => {
    const page = setup();
    installWebShellNavigationBridge();
    page.send({ type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "agent-rail" });
    expect(page.dataset.webShellEmbedded).toBe("1");
    expect(mocks.setNavigationLayout).not.toHaveBeenCalled();
  });

  it("rehydrates shared preferences without treating unrelated or session storage as a layout change", () => {
    const page = setup();
    const cleanup = installWebShellNavigationBridge();
    page.storage("unrelated");
    page.storage("agent-ui-prefs", {});
    expect(mocks.rehydrate).not.toHaveBeenCalled();
    page.storage("agent-ui-prefs");
    page.storage(null);
    expect(mocks.rehydrate).toHaveBeenCalledTimes(2);
    expect(mocks.setNavigationLayout).not.toHaveBeenCalled();
    cleanup();
    page.storage("agent-ui-prefs");
    expect(mocks.rehydrate).toHaveBeenCalledTimes(2);
  });

  it("rejects wrong origins, siblings, invalid layouts and skin messages", () => {
    const page = setup();
    installWebShellNavigationBridge();
    const message = { type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "classic" };
    page.send(message, page.parent, "https://untrusted.test");
    page.send(message, {});
    page.send({ ...message, navigationLayout: "glass" });
    page.send({ type: "agent-web-shell:skin:v1", skin: "glass" });
    page.send(null);
    expect(mocks.setNavigationLayout).not.toHaveBeenCalled();
  });
});
