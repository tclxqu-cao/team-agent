"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SharingView } from "../../lib/codex-sharing-service";

const labels = { shared: "已共享", independent: "独立后台", failed: "连接失败", stopped: "桌面未启动", "not-installed": "桌面未安装", unsupported: "暂不支持" };
export default function CodexSharingStatus({ csrfToken }: { csrfToken: string }) {
  const [status, setStatus] = useState<SharingView | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async (repair = false, share = false, restartConfirmed = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const attempt = generation.current;
    setBusy(true);
    try {
      const response = await fetch("/api/agent/codex-sharing", {
        method: repair || share ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
        headers: repair || share ? { "x-csrf-token": csrfToken, ...(share ? { "content-type": "application/json" } : {}) } : undefined,
        body: share ? JSON.stringify({ action: "share", restartConfirmed }) : undefined,
        signal: AbortSignal.timeout(180_000),
      });
      const result = await response.json();
      if (!response.ok || !Object.hasOwn(labels, result?.state)) throw new Error(result?.error?.message || "共享状态读取失败，请重试。");
      if (attempt !== generation.current) return;
      setStatus(result);
    } catch (cause) {
      if (attempt !== generation.current) return;
      setStatus({ state: "failed", configured: false, autoStart: false, daemonReachable: false, runtimeMode: null,
        message: cause instanceof Error ? cause.message : "无法连接当前电脑。" });
    } finally { inFlight.current = false; if (attempt === generation.current) setBusy(false); }
  }, [csrfToken]);
  useEffect(() => {
    void refresh();
    const check = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(check, 15_000);
    window.addEventListener("online", check);
    return () => { generation.current++; window.clearInterval(timer); window.removeEventListener("online", check); };
  }, [refresh]);
  const label = status ? labels[status.state] : "检查中";
  const share = () => {
    const restart = status?.state !== "stopped";
    if (restart && !window.confirm("切换将强制重启 Codex 桌面，中断桌面任务并可能丢失未发送内容，不再显示 Codex 退出确认框。共享后端和手机会话不会被结束。是否继续？")) return;
    void refresh(false, true, restart);
  };
  const needsAttention = status && status.state !== "unsupported" && (
    status.state !== "shared" || !status.configured || !status.autoStart || !status.daemonReachable
  );
  return <div className="codex-sharing">
    <style>{STYLES}</style>
    <div className="codex-sharing-title" role="status">
      <span className="codex-sharing-indicator" aria-hidden="true"><span className="codex-sharing-dot" data-state={status?.state} /></span>
      <span>Codex · {label}</span>
    </div>
    {needsAttention && <>
      <p>{status.state === "shared" ? "共享连接可用，启动配置需要修复。" : status.message}</p>
      <div className="codex-sharing-actions">
        <button type="button" disabled={busy} onClick={() => { void refresh(); }} aria-label="刷新 Codex 共享状态"><RefreshCw size={12} />刷新</button>
        <button type="button" disabled={busy} onClick={() => { void refresh(true); }}>{busy ? "正在修复…" : "检查并修复"}</button>
        {!["shared", "not-installed"].includes(status.state) && <button type="button" disabled={busy} onClick={share}>{busy ? "正在处理…" : status.state === "stopped" ? "以共享模式启动 Codex" : "切换到共享后端"}</button>}
      </div>
    </>}
  </div>;
}

const STYLES = `
.codex-sharing{padding:10px 14px;margin-bottom:6px;border-bottom:1px solid var(--ui-tabbar-border,#303442);color:var(--ui-text,#e8e8ee);font-size:13px;line-height:20px}
.codex-sharing-title{display:flex;align-items:center;gap:10px}
.codex-sharing-indicator{display:grid;place-items:center;flex:0 0 17px;height:17px}
.codex-sharing-dot{width:6px;height:6px;border-radius:50%;background:var(--ui-muted-text,#999dab)}
.codex-sharing-dot[data-state=shared]{background:var(--ui-success,#22c55e)}
.codex-sharing-dot[data-state=failed]{background:var(--ui-danger,#ef4444)}
.codex-sharing-dot[data-state=independent]{background:var(--ui-warning,#f59e0b)}
.codex-sharing p{margin:6px 0 0;color:var(--ui-muted-text,#999dab);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.codex-sharing-actions{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:4px}
.codex-sharing-actions button{display:flex;align-items:center;gap:5px;min-height:32px;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:inherit;font-size:12px;cursor:pointer}
.codex-sharing-actions button:focus-visible{outline:2px solid var(--ui-tab-accent,#7aa2f7);outline-offset:3px}
.codex-sharing-actions button:disabled{opacity:.5;cursor:wait}
@media(pointer:coarse){.codex-sharing-actions button{min-height:44px}}
`;
