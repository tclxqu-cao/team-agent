import { beforeEach, describe, expect, it, vi } from "vitest";
import { createJSONStorage } from "zustand/middleware";
import {
  getDefaultWakeEnabled,
  migrateUIPreferences,
  normalizePinnedSessionIds,
  useUIStore,
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
  useUIStore.setState({ pinnedSessionIds: [] });
});

describe("wake listening defaults", () => {
  it("keeps wake listening enabled for the desktop renderer", () => {
    expect(getDefaultWakeEnabled(false)).toBe(true);
  });

  it("starts the web shell with wake listening disabled", () => {
    expect(getDefaultWakeEnabled(true)).toBe(false);
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
