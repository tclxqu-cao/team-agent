import { afterEach, describe, expect, it, vi } from "vitest";
import { NAVIGATION_LAYOUT_MESSAGE } from "../../../core/src/domain/web-console/navigation-layout";

const mocks = vi.hoisted(() => ({ setNavigationLayout: vi.fn() }));
vi.mock("@desktop/renderer/stores/uiStore", () => ({ useUIStore: { getState: () => mocks } }));
import { installWebShellNavigationBridge } from "./web-shell-navigation";

function setup(embedded = true) {
  const parent = {};
  const callbacks = new Set<(event: unknown) => void>();
  const win = {
    parent: parent as unknown,
    location: { origin: "https://agent.test" },
    addEventListener: (_type: string, callback: (event: unknown) => void) => callbacks.add(callback),
    removeEventListener: (_type: string, callback: (event: unknown) => void) => callbacks.delete(callback),
  };
  if (!embedded) win.parent = win;
  const dataset: Record<string, string> = {};
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { body: { dataset } });
  return { callbacks, parent, dataset, send(data: unknown, source: unknown = parent, origin = win.location.origin) { callbacks.forEach(callback => callback({ data, source, origin })); } };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("web shell navigation bridge", () => {
  it("does not hide the only layout button in standalone or PWA pages", () => {
    const page = setup(false);
    const cleanup = installWebShellNavigationBridge();
    expect(page.callbacks.size).toBe(0);
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
    expect(mocks.setNavigationLayout.mock.calls).toEqual([["classic"], ["agent-rail"]]);
    cleanup();
    expect(page.callbacks.size).toBe(0);
    expect(page.dataset.webShellEmbedded).toBeUndefined();
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
