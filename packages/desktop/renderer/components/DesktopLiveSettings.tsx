import { useEffect, useState } from "react";
import type { DesktopLiveDisplayOption, DesktopLiveStatus } from "../global";

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
export default function DesktopLiveSettings({ onboarding = false }: { onboarding?: boolean }) {
  const api = typeof window === "undefined" ? undefined : window.agentApi;
  const supported = Boolean(api?.desktopLiveGetStatus);
  const [status, setStatus] = useState<DesktopLiveStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [platformSupported, setPlatformSupported] = useState(true);
  const [displays, setDisplays] = useState<DesktopLiveDisplayOption[] | null>(null);

  useEffect(() => {
    if (!api?.desktopLiveGetStatus || !api?.onDesktopLiveStatus) return;
    let active = true;
    void api.desktopLiveSetup()
      .then((next) => { if (active) { setStatus(next.status); setPlatformSupported(next.supported); } })
      .catch(() => undefined);
    void api.desktopLiveGetDisplays?.()
      .then((result) => { if (active && result.displays.length > 1) setDisplays(result.displays); })
      .catch(() => undefined);
    const unsubscribe = api.onDesktopLiveStatus((next) => setStatus(next));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [api]);


  const recheck = async () => {
    if (!api?.desktopLiveRecheck) return;
    try { setStatus(await api.desktopLiveRecheck()); setError(null); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };

  useEffect(() => {
    if (!supported || !platformSupported) return;
    let active = true;
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try { const next = await api!.desktopLiveRecheck(); if (active) setStatus(next); }
      catch { /* Explicit recheck exposes errors; background checks remain quiet. */ }
      finally { checking = false; }
    };
    window.addEventListener("focus", check);
    const timer = status?.enabled && (status.permissionScreen !== "granted" || status.accessibilityTrusted !== true) ? window.setInterval(check, 3000) : undefined;
    return () => { active = false; window.removeEventListener("focus", check); if (timer) window.clearInterval(timer); };
  }, [api, supported, platformSupported, status?.enabled, status?.permissionScreen, status?.accessibilityTrusted]);

  const authorize = async (permission: "screen" | "accessibility") => {
    if (!api) return;
    setPending(true);
    try {
      setStatus(await api.desktopLiveSetEnabled(true));
      await api.desktopLiveOpenPermission(permission);
      setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };

  const selectDisplay = async (displayId: string | null) => {
    if (!api?.desktopLiveSetDisplay) return;
    try {
      await api.desktopLiveSetDisplay(displayId);
      const result = await api.desktopLiveGetDisplays?.();
      if (result) setDisplays(result.displays);
    } catch { /* keep the previous selection on failure */ }
  };

  if (!supported) return null;

  const toggle = async () => {
    if (!api?.desktopLiveSetEnabled) return;
    setPending(true);
    try {
      setStatus(await api.desktopLiveSetEnabled(!status?.enabled));
      setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setPending(false); }
  };

  const screenGranted = status?.permissionScreen === "granted";
  const accessibilityTrusted = status?.accessibilityTrusted === true;

  return (
    <section className="desktop-permission-settings">
      <h3 style={headingStyle}>{onboarding ? "设置桌面端权限" : "桌面直播与远程控制"}</h3>
      <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "0 0 14px", lineHeight: 1.6 }}>
        {onboarding ? "欢迎使用 AgentRoam。请为桌面端开启以下系统权限，完成后手机即可查看电脑画面；允许辅助功能后还可操作鼠标和键盘。" : "开启后，已配对手机可查看电脑画面，并在授予辅助功能权限后操作鼠标和键盘。"}

      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => void toggle()}
          disabled={pending || !platformSupported}
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
          {pending ? "处理中…" : status?.enabled ? (onboarding ? "暂停手机查看" : "关闭桌面直播") : (onboarding ? "开启手机查看" : "开启桌面直播")}
        </button>
        {status?.enabled && (
          <span style={{ fontSize: 12, color: status.sessionOnline ? "var(--success)" : "var(--text-muted)" }}>
            {status.sessionOnline ? "● 已连接，可从手机查看" : "○ 未连接"}
          </span>
        )}
      </div>

      {!platformSupported && <p role="status">当前远程桌面仅支持 macOS，其他桌面功能可正常使用。</p>}
      {platformSupported && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div className="desktop-permission-row" style={permissionRowStyle}>
            <span>屏幕录制（画面采集）</span>
            <span style={{ color: screenGranted ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
              {screenGranted ? "已授权" : "未授权"}
            </span>
            {!screenGranted && <button type="button" className="ui-quiet-button desktop-permission-button" disabled={pending} onClick={() => void authorize("screen")}>去授权</button>}
          </div>
          <div className="desktop-permission-row" style={permissionRowStyle}>
            <span>辅助功能（键鼠控制）</span>
            <span style={{ color: accessibilityTrusted ? "var(--success)" : "var(--danger)", fontWeight: 600 }}>
              {status?.accessibilityTrusted === null ? "待检测" : accessibilityTrusted ? "已授权" : "未授权"}
            </span>
            {!accessibilityTrusted && <button type="button" className="ui-quiet-button desktop-permission-button" disabled={pending} onClick={() => void authorize("accessibility")}>去授权</button>}
          </div>
          {displays && displays.length > 1 && (
            <div style={permissionRowStyle}>
              <span>直播画面来源</span>
              <span style={{ display: "flex", gap: 6 }}>
                {displays.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => void selectDisplay(item.selected ? null : item.id)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: "var(--radius-sm)",
                      border: `1px solid ${item.selected ? "var(--accent)" : "var(--border-subtle)"}`,
                      background: item.selected ? "var(--accent-dim)" : "transparent",
                      color: item.selected ? "var(--accent)" : "var(--text-secondary)",
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </span>
            </div>
          )}
        </div>
      )}
      {platformSupported && <>
        <p style={{ marginTop: 14, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.6 }}>点击对应权限的「去授权」，在系统设置中允许 AgentRoam，返回后自动检测。</p>
        <details className="desktop-permission-more"><summary>更多操作</summary><div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <button type="button" className="ui-quiet-button" onClick={() => void recheck()}>重新检测</button>
          {!screenGranted && <button type="button" className="ui-quiet-button" onClick={() => void api?.desktopLiveRestart()}>重启桌面端</button>}
        </div></details>
      </>}
      {error && <p role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
      {status?.error && (
        <div style={{ marginTop: 10, fontSize: 12, color: "var(--danger)" }} role="alert">{status.error}</div>
      )}
    </section>
  );
}
