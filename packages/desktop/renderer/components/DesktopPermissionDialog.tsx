import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DesktopLiveSettings from "./DesktopLiveSettings";

/** First-run desktop permission guidance, independent of remote-view navigation. */
export default function DesktopPermissionDialog({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    const update = (status: import("../global").DesktopLiveStatus) => {
      if (active) setReady(status.enabled && status.permissionScreen === "granted" && status.sessionOnline);
    };
    void window.agentApi.desktopLiveGetStatus().then(update).catch(() => undefined);
    const unsubscribe = window.agentApi.onDesktopLiveStatus(update);
    return () => { active = false; unsubscribe(); };
  }, []);
  return createPortal(
    <dialog ref={dialog} aria-label="桌面端权限引导" onCancel={onClose}
      style={{ margin: "auto", inset: 0, overflowY: "auto", width: "min(600px, calc(100vw - 40px))", maxHeight: "calc(100vh - 40px)", padding: 24, borderRadius: "var(--radius-md)", border: "1px solid var(--border-default)", background: "var(--bg-surface)", color: "var(--text-primary)" }}>
      <DesktopLiveSettings onboarding />
      <button type="button" className="ui-quiet-button" onClick={onClose}>{ready ? "完成" : "稍后设置"}</button>
    </dialog>, document.body,
  );
}
