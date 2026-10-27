import { DEFAULT_NAVIGATION_LAYOUT, isNavigationLayout, type NavigationLayout } from "../../../core/src/domain/web-console/navigation-layout";

// The console iframe and desktop renderer persist the same UI preference record.
export const UI_PREFERENCES_KEY = "agent-ui-prefs";

export function readNavigationLayoutPreference(storage?: Pick<Storage, "getItem">): NavigationLayout {
  try {
    const stored = JSON.parse(storage?.getItem(UI_PREFERENCES_KEY) ?? "null");
    return isNavigationLayout(stored?.state?.navigationLayout) ? stored.state.navigationLayout : DEFAULT_NAVIGATION_LAYOUT;
  } catch { return DEFAULT_NAVIGATION_LAYOUT; }
}

export function writeNavigationLayoutPreference(storage: Pick<Storage, "getItem" | "setItem">, navigationLayout: NavigationLayout): void {
  try {
    let raw: unknown;
    try { raw = JSON.parse(storage.getItem(UI_PREFERENCES_KEY) ?? "null"); }
    catch { raw = null; }
    const stored = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const state = stored.state && typeof stored.state === "object" && !Array.isArray(stored.state) ? stored.state : {};
    storage.setItem(UI_PREFERENCES_KEY, JSON.stringify({ ...stored, version: stored.version ?? 4, state: { ...state, navigationLayout } }));
  } catch { /* Layout remains usable when browser storage is unavailable. */ }
}
