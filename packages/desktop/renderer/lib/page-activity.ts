import { useSyncExternalStore } from "react";
import { PAGE_ACTIVITY_REQUEST, readPageActivity } from "../../../core/src/domain/web-console/PageActivityBridge";

/** Keeps offscreen Shell frames quiet without unmounting their state or stopping runs. */
export function createPageActivity(host: Window) {
  let frameActive = host.parent === host;
  let listening = false;
  const listeners = new Set<() => void>();
  const active = () => frameActive && host.document.visibilityState !== "hidden";
  let previous = active();
  const notify = () => {
    const next = active();
    if (next === previous) return;
    previous = next;
    listeners.forEach(listener => listener());
  };
  const receive = (event: MessageEvent) => {
    const next = readPageActivity(event, host.location.origin, host.parent);
    if (next === null) return;
    frameActive = next;
    notify();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!listening) {
      listening = true;
      host.addEventListener("message", receive);
      host.document.addEventListener("visibilitychange", notify);
      if (host.parent !== host) host.parent.postMessage({ type: PAGE_ACTIVITY_REQUEST }, host.location.origin);
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      host.removeEventListener("message", receive);
      host.document.removeEventListener("visibilitychange", notify);
      listening = false;
    };
  };
  return { active, subscribe };
}

let activity: ReturnType<typeof createPageActivity> | undefined;
function pageActivity() { return activity ??= createPageActivity(window); }
export function isPageActive(): boolean { return typeof window !== "undefined" && pageActivity().active(); }
export function usePageActive(): boolean {
  const state = typeof window === "undefined"
    ? { subscribe: () => () => {}, active: () => false }
    : pageActivity();
  return useSyncExternalStore(state.subscribe, state.active, () => false);
}
