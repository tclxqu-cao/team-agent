import { useEffect, useRef, useState } from "react";
import type { DesktopLiveCliStatus } from "../../main/desktop-live-cli-proxy";
import type { LiteApi } from "./api";

export function PermissionDialog({ api, onClose }: { api: LiteApi; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [status, setStatus] = useState<DesktopLiveCliStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    void api.authorization("status").then(value => { if (alive.current) setStatus(value); }).catch(() => { if (alive.current) setError("无法读取授权状态，请点击重新检查。"); });
    return () => { alive.current = false; dialog.current?.close(); };
  }, [api]);
  const act = async (action: "enable" | "recheck" | "restart" | "authorize", permission?: "screen" | "accessibility") => {
    setBusy(true); setError("");
    try { const value = await api.authorization(action, permission); if (alive.current) setStatus(value); }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : "授权未完成，请重试。"); }
    finally { if (alive.current) setBusy(false); }
  };
  const ready = status?.enabled && status.permissionScreen === "granted" && status.accessibilityTrusted === true && status.sessionOnline;
  return <dialog className="lite-permissions" ref={dialog} aria-labelledby="permission-title" onCancel={onClose}>
    <h2 id="permission-title">远程桌面授权</h2><p>在手机上查看和控制电脑前，请先完成系统授权。终端和 Agent 会话可先扫码使用。</p>
    {status?.supported === false ? <p>当前系统暂不支持远程桌面。</p> : <>
      <div className="lite-permission-row"><span>远程桌面服务<small>{status?.enabled ? (status.sessionOnline ? "已开启" : "正在连接") : "等待开启"}</small></span><button disabled={busy || !status} onClick={() => void act(status?.enabled ? "restart" : "enable")}>{status?.enabled ? "重新连接" : "开启"}</button></div>
      {status?.platform === "darwin" && <>
        <div className="lite-permission-row"><span>屏幕录制<small>{status.permissionScreen === "granted" ? "已授权" : "未授权"}</small></span><button disabled={busy} onClick={() => void act("authorize", "screen")}>去授权</button></div>
        <div className="lite-permission-row"><span>辅助功能<small>{status.accessibilityTrusted ? "已授权" : "未授权"}</small></span><button disabled={busy} onClick={() => void act("authorize", "accessibility")}>去授权</button></div>
      </>}
      <p className="lite-permission-note">{ready ? "授权已完成，可以扫码连接。" : "完成系统授权后，点击「重新检查」更新状态。"}</p>
    </>}
    {(error || status?.error) && <p role="alert">{error || status?.error}</p>}
    <div className="lite-actions"><button disabled={busy} onClick={() => void act("recheck")}>{busy ? "处理中…" : "重新检查"}</button><button className="lite-primary" onClick={onClose}>{ready ? "完成" : "稍后设置"}</button></div>
  </dialog>;
}
