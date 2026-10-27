import { describe, expect, it } from "vitest";
import { UI_PREFERENCES_KEY, readNavigationLayoutPreference, writeNavigationLayoutPreference } from "./navigation-layout-preference";

function storage(initial: string | null = null) {
  let value = initial;
  return { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } };
}

describe("navigation layout persistence", () => {
  it("preserves skin, chat layout, wake listening, pinned sessions and persistence version", () => {
    const state = { skin: "glass", layout: "compact", wakeEnabled: false, pinnedSessionIds: ["existing"] };
    const store = storage(JSON.stringify({ version: 4, state }));
    writeNavigationLayoutPreference(store, "classic");
    expect(JSON.parse(store.getItem()!)).toEqual({ version: 4, state: { ...state, navigationLayout: "classic" } });
    expect(readNavigationLayoutPreference(store)).toBe("classic");
    writeNavigationLayoutPreference(store, "agent-rail");
    expect(JSON.parse(store.getItem()!).state).toEqual({ ...state, navigationLayout: "agent-rail" });
  });

  it.each([null, "{bad", "[]", '{"state":{"navigationLayout":"glass"}}'])("recovers invalid or absent preferences %j", initial => {
    const store = storage(initial);
    expect(readNavigationLayoutPreference(store)).toBe("agent-rail");
    writeNavigationLayoutPreference(store, "classic");
    expect(readNavigationLayoutPreference(store)).toBe("classic");
    expect(JSON.parse(store.getItem()!).version).toBe(4);
  });

  it("degrades safely when browser storage is blocked", () => {
    const store = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readNavigationLayoutPreference(store)).toBe("agent-rail");
    expect(() => writeNavigationLayoutPreference(store, "classic")).not.toThrow();
    expect(UI_PREFERENCES_KEY).toBe("agent-ui-prefs");
  });
});
