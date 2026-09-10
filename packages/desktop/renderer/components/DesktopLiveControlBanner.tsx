import { useEffect, useState } from "react";
import type { DesktopLiveStatus } from "../global";

/**
 * Fixed on-screen banner shown on this machine while a remote viewer controls
 * the desktop, so local control is never silent. Desktop app only.
 */
export default function DesktopLiveControlBanner() {
  const [status, setStatus] = useState<DesktopLiveStatus | null>(null);

  useEffect(() => {
    const api = window.agentApi;
    if (!api?.desktopLiveGetStatus || !api?.onDesktopLiveStatus) return;
    let active = true;
    void api.desktopLiveGetStatus()
      .then((next) => { if (active) setStatus(next); })
      .catch(() => undefined);
    const unsubscribe = api.onDesktopLiveStatus((next) => setStatus(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const state = status?.controlState;
  const controlled = status?.enabled && state !== null && state !== undefined && state !== "agent-controlled";
  if (!controlled) return null;
  const ending = state === "return-requested" || state === "resyncing";

  return (
    <div
      className="desktop-live-control-banner"
      role="status"
      style={{
        position: "fixed",
        top: "calc(env(safe-area-inset-top) + 10px)",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1300,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 14px",
        borderRadius: 999,
        border: "1px solid rgba(251,191,36,0.45)",
        background: "rgba(69,49,10,0.92)",
        color: "#fcd34d",
        fontSize: 13,
        fontWeight: 600,
        backdropFilter: "blur(8px)",
        pointerEvents: "none",
      } as React.CSSProperties}
    >
      <span aria-hidden="true">●</span>
      {ending ? "正在结束远程控制" : "正在被远程控制"}
    </div>
  );
}
