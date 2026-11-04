import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import { useUIStore } from "../../../desktop/renderer/stores/uiStore";
import { NAVIGATION_LAYOUT_MESSAGE } from "../../../core/src/domain/web-console/navigation-layout";

vi.mock("@desktop/renderer/stores/uiStore", async () => import("../../../desktop/renderer/stores/uiStore"));
import { installWebShellNavigationBridge } from "./web-shell-navigation";
import { installWebShellSkinBridge, WEB_SHELL_SKIN_MESSAGE_TYPE } from "./web-shell-skin";

function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: (key: string) => { values.delete(key); },
  };
  vi.stubGlobal("localStorage", storage);
  useUIStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  useUIStore.setState({ skin: "glass", navigationLayout: "classic", layout: "compact", pinnedSessionIds: ["old"] });
  const parent = {};
  const listeners = new Map<string, Set<EventListener>>();
  const win = {
    parent, location: { origin: "https://agent.test" }, localStorage: storage,
    addEventListener: (type: string, listener: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener: (type: string, listener: EventListener) => { listeners.get(type)?.delete(listener); },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", { body: { dataset: {} } });
  const cleanups = [installWebShellSkinBridge(), installWebShellNavigationBridge()];
  return {
    storage,
    cleanup: () => cleanups.forEach(cleanup => cleanup()),
    message: (data: unknown) => listeners.get("message")?.forEach(listener => listener({ data, source: parent, origin: win.location.origin } as MessageEvent)),
    changed: () => listeners.get("storage")?.forEach(listener => listener({ key: "agent-ui-prefs", storageArea: storage } as unknown as StorageEvent)),
  };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

it("keeps a Dashboard pane from reverting the new sidebar layout when the shell resends its skin", () => {
  const page = setup();
  const record = JSON.parse(page.storage.getItem("agent-ui-prefs")!);
  page.storage.setItem("agent-ui-prefs", JSON.stringify({ ...record, state: { ...record.state, navigationLayout: "all-sessions", pinnedSessionIds: ["new"] } }));
  page.storage.setItem.mockClear();

  // The Dashboard still has its old in-memory layout when this message arrives.
  page.message({ type: WEB_SHELL_SKIN_MESSAGE_TYPE, skin: "glass" });
  expect(JSON.parse(page.storage.getItem("agent-ui-prefs")!).state.navigationLayout).toBe("all-sessions");
  expect(page.storage.setItem).not.toHaveBeenCalled();

  page.changed();
  expect(useUIStore.getState()).toMatchObject({ navigationLayout: "all-sessions", pinnedSessionIds: ["new"], layout: "compact" });
  page.message({ type: NAVIGATION_LAYOUT_MESSAGE, navigationLayout: "all-sessions" });
  expect(page.storage.setItem).not.toHaveBeenCalled();

  useUIStore.getState().setNavigationLayout("agent-rail");
  expect(page.storage.setItem).toHaveBeenCalledTimes(1);
  expect(JSON.parse(page.storage.getItem("agent-ui-prefs")!).state).toMatchObject({ navigationLayout: "agent-rail", pinnedSessionIds: ["new"], layout: "compact", skin: "glass" });
  page.cleanup();
});
