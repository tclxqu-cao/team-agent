import { useEffect, useState } from "react";
import type { DesktopLiveStatus } from "../global";

const headingStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 14,
};

const permissionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  padding: "8px 12px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-subtle)",
  background: "var(--bg-surface)",
  fontSize: 13,
};

/** Settings section for the desktop live view / remote control switch. Desktop app only. */
export default function DesktopLiveSettings() {
  const api = typeof window === "undefined" ? undefined : window.agentApi;
  const supported = Boolean(api?.desktopLiveGetStatus);
  const [status, setStatus] = useState<DesktopLiveStatus | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
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
  }, [api]);

  if (!supported) return null;

  const toggle = async () => {
    if (!api?.desktopLiveSetEnabled) return;
    setPending(true);
    try {
      setStatus(await api.desktopLiveSetEnabled(!status?.enabled));
    } finally {
      setPending(false);
    }
  };

  const screenGranted = status?.permissionScreen === "granted";
  const accessibilityTrusted = status?.accessibilityTrusted === true;

  return (
    <section style={{ marginBottom: 40 }}>
      <h3 style={headingStyle}>桌面直播与远程控制</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.6 }}>
        开启后，本机桌面画面会发布到直播面板，可从你的其他设备（如手机）观看并控制这台电脑的鼠标键盘。默认关闭；
        被远程操作时桌面端会显示提示。首次使用需要在「系统设置 → 隐私与安全性」中授予屏幕录制与辅助功能权限。
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={pending}
          style={{
            padding: "7px 16px",
            borderRadius: "var(--radius-sm)",
            border: `1px solid ${status?.enabled ? "rgba(244,63,94,0.35)" : "var(--accent)"}`,
            background: status?.enabled ? "rgba(244,63,94,0.1)" : "var(--accent-dim)",
            color: status?.enabled ? "var(--danger)" : "var(--accent)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          {pending ? "处理中…" : status?.enabled ? "关闭桌面直播" : "开启桌面直播"}
        </button>
        {status?.enabled && (
          <span style={{ fontSize: 12, color: status.sessionOnline ? "var(--success)" : "var(--text-muted)" }}>
            {status.sessionOnline ? "● 直播中" : "○ 未连接"}
          </span>
        )}
      </div>

      {status?.enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={permissionRowStyle}>
            <span>屏幕录制（画面采集）</span>
            <span style={{ color: screenGranted ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
              {screenGranted ? "已授权" : "未授权"}
            </span>
          </div>
          <div style={permissionRowStyle}>
            <span>辅助功能（键鼠控制）</span>
            <span style={{ color: accessibilityTrusted ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
              {status?.accessibilityTrusted === null ? "未知" : accessibilityTrusted ? "已授权" : "未授权"}
            </span>
          </div>
        </div>
      )}
      {status?.error && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger)" }} role="alert">{status.error}</div>
      )}
    </section>
  );
}
