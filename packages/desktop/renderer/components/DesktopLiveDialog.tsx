import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import DesktopLiveSettings from "./DesktopLiveSettings";

export default function DesktopLiveDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  return createPortal(
    <dialog
      ref={dialogRef}
      aria-label="桌面直播与远程控制"
      onCancel={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      style={{
        width: "min(680px, calc(100vw - 48px))",
        maxHeight: "calc(100vh - 48px)",
        padding: 0,
        margin: "auto",
        inset: 0,
        overflowY: "auto",
        color: "var(--text-primary)",
        background: "var(--bg-surface)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-md)",
      }}
    >
      <div style={{ padding: 24 }}>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
          <button type="button" onClick={onClose} aria-label="关闭桌面直播设置" className="ui-icon-button ui-icon-button--close">×</button>
        </div>
        <DesktopLiveSettings />
        <div className="desktop-permission-footer"><button type="button" className="ui-quiet-button" onClick={onClose}>关闭</button></div>
      </div>
    </dialog>,
    document.body,
  );
}
