import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import {
  getDefaultWakeEnabled,
  migrateUIPreferences,
  normalizePinnedSessionIds,
  useUIStore,
  SKINS,
  LAYOUTS,
} from "./uiStore";

beforeEach(() => {
  const values = new Map<string, string>();
  const localStorageMock = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
  };
  vi.stubGlobal("localStorage", localStorageMock);
  useUIStore.persist.setOptions({ storage: createJSONStorage(() => localStorageMock) });
  useUIStore.setState({ pinnedSessionIds: [], dashboardSessionsMerged: false });
});

describe("wake listening defaults", () => {
  it("keeps wake listening enabled for the desktop renderer", () => {
    expect(getDefaultWakeEnabled(false)).toBe(true);
  });

  it("starts the web shell with wake listening disabled", () => {
    expect(getDefaultWakeEnabled(true)).toBe(false);
  });
});

describe("dashboard session display preference", () => {
  it("persists the merged view and restores it when preferences are rehydrated", async () => {
    useUIStore.getState().setDashboardSessionsMerged(true);
    const saved = localStorage.getItem("agent-ui-prefs")!;
    expect(JSON.parse(saved).state.dashboardSessionsMerged).toBe(true);
    useUIStore.getState().setDashboardSessionsMerged(false);
    localStorage.setItem("agent-ui-prefs", saved);
    await useUIStore.persist.rehydrate();
    expect(useUIStore.getState().dashboardSessionsMerged).toBe(true);
  });

  it("migrates boolean display preferences while older or invalid preferences keep the default", () => {
    expect(migrateUIPreferences({ dashboardSessionsMerged: true }, 3)).toMatchObject({ dashboardSessionsMerged: true });
    expect(migrateUIPreferences({ dashboardSessionsMerged: false }, 3)).toMatchObject({ dashboardSessionsMerged: false });
    expect(migrateUIPreferences({ dashboardSessionsMerged: "true" }, 3)).not.toHaveProperty("dashboardSessionsMerged");
    expect(migrateUIPreferences({}, 3)).not.toHaveProperty("dashboardSessionsMerged");
  });
});

describe("pinned session preferences", () => {
  it("normalizes malformed, empty, and duplicate persisted IDs", () => {
    expect(normalizePinnedSessionIds(["session-a", "", "session-a", 7, "session-b"])).toEqual([
      "session-a",
      "session-b",
    ]);
    expect(normalizePinnedSessionIds("session-a")).toEqual([]);
    expect(migrateUIPreferences({ pinnedSessionIds: ["session-a", "session-a"] }, 4).pinnedSessionIds)
      .toEqual(["session-a"]);
  });

  it("toggles and removes pinned session IDs without duplicates", () => {
    const store = useUIStore.getState();
    store.togglePinnedSession("session-a");
    useUIStore.getState().togglePinnedSession("session-b");
    useUIStore.getState().togglePinnedSession("session-a");
    useUIStore.getState().togglePinnedSession("session-a");

    expect(useUIStore.getState().pinnedSessionIds).toEqual(["session-b", "session-a"]);
    useUIStore.getState().removePinnedSessions(["session-a", "missing"]);
    expect(useUIStore.getState().pinnedSessionIds).toEqual(["session-b"]);
  });
});

describe("glass skin", () => {
  it("registers a selectable skin without changing layout or session preferences", () => {
    expect(SKINS.find((skin) => skin.id === "glass")?.label).toBe("毛玻璃");
    useUIStore.setState({ skin: "pearl", layout: "compact", pinnedSessionIds: ["existing"] });
    useUIStore.getState().setSkin("glass");
    expect(useUIStore.getState()).toMatchObject({ skin: "glass", layout: "compact", pinnedSessionIds: ["existing"] });
    expect(JSON.parse(localStorage.getItem("agent-ui-prefs")!).state.skin).toBe("glass");
    expect(migrateUIPreferences({ skin: "glass", layout: "compact" }, 4)).toMatchObject({ skin: "glass", layout: "compact" });
    useUIStore.getState().setSkin("pearl");
    expect(useUIStore.getState().skin).toBe("pearl");
  });
});

describe("navigation layout preferences", () => {
  it.each(SKINS.flatMap(({ id: skin }) => LAYOUTS.map(({ id: layout }) => ({ skin, layout }))))(
    "switches classic and rail without changing $skin / $layout or sessions",
    ({ skin, layout }) => {
      useUIStore.setState({ skin, layout, pinnedSessionIds: ["existing"], wakeEnabled: false });
      for (const navigationLayout of ["classic", "agent-rail"] as const) {
        useUIStore.getState().setNavigationLayout(navigationLayout);
        const expected = { skin, layout, pinnedSessionIds: ["existing"], wakeEnabled: false, navigationLayout };
        expect(useUIStore.getState()).toMatchObject(expected);
        expect(JSON.parse(localStorage.getItem("agent-ui-prefs")!).state).toMatchObject(expected);
      }
      useUIStore.getState().setSkin("pearl");
      expect(useUIStore.getState().navigationLayout).toBe("agent-rail");
    },
  );

  it("migrates a valid preference without accepting skin or chat layout IDs as navigation", () => {
    expect(migrateUIPreferences({ navigationLayout: "classic", skin: "glass" }, 4)).toMatchObject({ navigationLayout: "classic", skin: "glass" });
    expect(migrateUIPreferences({ navigationLayout: "compact" }, 4)).not.toHaveProperty("navigationLayout");
    expect(migrateUIPreferences({}, 4)).not.toHaveProperty("navigationLayout");
  });
});
