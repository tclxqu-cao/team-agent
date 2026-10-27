import { readNavigationLayoutMessage } from "../../../core/src/domain/web-console/navigation-layout";
import { useUIStore } from "@desktop/renderer/stores/uiStore";

export function installWebShellNavigationBridge(): () => void {
  if (window.parent === window) return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const layout = readNavigationLayoutMessage(event.data);
    if (layout) {
      document.body.dataset.webShellEmbedded = "1";
      useUIStore.getState().setNavigationLayout(layout);
    }
  };
  window.addEventListener("message", onMessage);
  return () => {
    window.removeEventListener("message", onMessage);
    delete document.body.dataset.webShellEmbedded;
  };
}
