import { readNavigationLayoutMessage } from "../../../core/src/domain/web-console/navigation-layout";
import { useUIStore } from "@desktop/renderer/stores/uiStore";

export function installWebShellNavigationBridge(): () => void {
  if (window.parent === window) return () => {};
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== window.location.origin || event.source !== window.parent) return;
    const layout = readNavigationLayoutMessage(event.data);
    if (layout) {
      document.body.dataset.webShellEmbedded = "1";
      const state = useUIStore.getState();
      if (state.navigationLayout !== layout) state.setNavigationLayout(layout);
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== useUIStore.persist.getOptions().name) return;
    // Every pane has its own store but shares the same persisted record. Read
    // the latest record without echoing a stale pane's preferences back to it.
    void useUIStore.persist.rehydrate();
  };
  window.addEventListener("message", onMessage);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("message", onMessage);
    window.removeEventListener("storage", onStorage);
    delete document.body.dataset.webShellEmbedded;
  };
}
