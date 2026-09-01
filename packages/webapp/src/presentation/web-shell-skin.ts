import { useUIStore, type SkinId } from "@desktop/renderer/stores/uiStore";

export const WEB_SHELL_SKIN_MESSAGE_TYPE = "agent-web-shell:skin:v1";

const SKIN_IDS: SkinId[] = ["pearl", "scifi", "noir"];

/**
 * Applies the parent shell's skin choice (tab-bar avatar popover) to the
 * embedded renderer UI so both documents share one skin. Only active inside
 * the shell iframe; a no-op when the webapp runs standalone.
 */
export function installWebShellSkinBridge(): () => void {
  if (window.parent === window) return () => {};

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const data = event.data as { type?: unknown; skin?: unknown } | null;
    if (!data || typeof data !== "object" || data.type !== WEB_SHELL_SKIN_MESSAGE_TYPE) return;
    if (typeof data.skin !== "string" || !SKIN_IDS.includes(data.skin as SkinId)) return;
    useUIStore.getState().setSkin(data.skin as SkinId);
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
