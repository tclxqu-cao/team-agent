import { useEffect, useState } from "react";
import BrowserLivePanel from "@desktop/renderer/components/BrowserLivePanel";
import { useUIStore } from "@desktop/renderer/stores/uiStore";
import { readRemoteDesktopVisibility, REMOTE_DESKTOP_CLOSE_TYPE, REMOTE_DESKTOP_CONTENT_READY_TYPE } from "../../../core/src/domain/web-console/RemoteDesktopTabBridge";

export default function RemoteDesktopPage() {
  const [visible, setVisible] = useState(false);
  const [skin, setSkin] = useState(useUIStore.getState().skin);
  useEffect(() => useUIStore.subscribe((state) => setSkin(state.skin)), []);
  useEffect(() => {
    document.documentElement.dataset.skin = skin;
    document.body.dataset.remoteDesktop = "1";
  }, [skin]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const next = readRemoteDesktopVisibility(event, location.origin, window.parent);
      if (next !== null) setVisible(next);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  useEffect(() => {
    if (!visible) return;
    // The shell can reveal the iframe once the live panel has mounted.
    const frame = requestAnimationFrame(() => {
      window.parent.postMessage({ type: REMOTE_DESKTOP_CONTENT_READY_TYPE }, location.origin);
    });
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  return <BrowserLivePanel open={visible} onClose={() => {
    setVisible(false);
    window.parent.postMessage({ type: REMOTE_DESKTOP_CLOSE_TYPE }, location.origin);
  }} />;
}
