import { OPEN_BROWSER_LIVE_EVENT } from "../../../desktop/renderer/web/shellEvents";
import { WEB_SHELL_OPEN_BROWSER_LIVE_TYPE } from "../../../core/src/domain/web-console/WebShellLiveBridge";

/**
 * Shell → webapp "open the browser-live panel" request. The shell's tab-bar
 * button posts the message; this bridge validates origin/source and re-emits
 * it as the renderer-side DOM event that ChatView listens for. Standalone
 * webapp (no parent frame) is a no-op.
 */
export function installWebShellLiveBridge(): () => void {
  if (window.parent === window) return () => {};

  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const data = event.data as { type?: unknown } | null;
    if (!data || typeof data !== "object" || data.type !== WEB_SHELL_OPEN_BROWSER_LIVE_TYPE) return;
    window.dispatchEvent(new CustomEvent(OPEN_BROWSER_LIVE_EVENT));
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
