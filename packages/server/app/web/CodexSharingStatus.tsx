"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SharingView } from "../../lib/codex-sharing-service";

const labels = { shared: "已共享", independent: "独立后台", failed: "连接失败", stopped: "桌面未启动", "not-installed": "桌面未安装", unsupported: "暂不支持" };
export default function CodexSharingStatus({ csrfToken, expanded }: { csrfToken: string; expanded: boolean }) {
  const [status, setStatus] = useState<SharingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async (repair = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    const attempt = generation.current;
    if (repair) { setBusy(true); setNotice(""); }
    try {
      const response = await fetch("/api/agent/codex-sharing", {
        method: repair ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
        headers: repair ? { "x-csrf-token": csrfToken } : undefined, signal: AbortSignal.timeout(50_000),
      });
      const result = await response.json();
      if (!response.ok || !Object.hasOwn(labels, result?.state)) throw new Error(result?.error?.message || "共享状态读取失败，请重试。");
      if (attempt !== generation.current) return;
      setStatus(result);
      if (repair) setNotice(result.configured && result.autoStart && result.daemonReachable
        ? "已保存默认共享与自动恢复配置。" : "配置或后台仍未就绪，请重试。");
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
  const healthy = status?.state === "shared";
  const content = <><span className="codex-sharing-dot" data-state={status?.state} /><span>Codex · {label}</span></>;
  return <div className={`codex-sharing ${expanded ? "codex-sharing-expanded" : "codex-sharing-compact"}`}>
    <style>{`.codex-sharing{font-size:12px;color:var(--text-secondary);display:flex;gap:7px;align-items:center}.codex-sharing-compact{margin-inline:6px}.codex-sharing-compact button{display:flex;align-items:center;gap:6px;border:0;background:none;color:inherit;cursor:pointer;padding:5px 2px;font:inherit}.codex-sharing-dot{width:6px;height:6px;border-radius:50%;background:#a1a1aa;flex-shrink:0}.codex-sharing-dot[data-state=shared]{background:#22c55e}.codex-sharing-dot[data-state=failed]{background:#ef4444}.codex-sharing-dot[data-state=independent]{background:#f59e0b}.codex-sharing-expanded{display:block;padding:10px 14px;border-bottom:1px solid var(--border-color,rgba(128,128,128,.16))}.codex-sharing-title{display:flex;align-items:center;gap:7px;color:var(--text-primary)}.codex-sharing p{font-size:11px;line-height:1.6;margin:5px 0 8px}.codex-sharing-actions{display:flex;gap:12px}.codex-sharing-actions button{border:0;background:none;color:inherit;font:inherit;padding:3px 0;cursor:pointer;display:flex;align-items:center;gap:5px}.codex-sharing button:disabled{opacity:.5;cursor:wait}@media(max-width:600px){.codex-sharing-compact{font-size:10px;margin-inline:2px}}`}</style>
    {expanded ? <>
      <div className="codex-sharing-title" role="status">{content}</div>
      <p>{status?.message || "正在核对共享后台与桌面实际连接…"}</p>
      {status && <p>默认共享 {status.configured ? "已配置" : "未配置"} · 自动恢复 {status.autoStart ? "已启用" : "未启用"}</p>}
      {notice && <p role="status">{notice}</p>}
      <div className="codex-sharing-actions">
        <button type="button" disabled={busy} onClick={() => { void refresh(); }} aria-label="刷新 Codex 共享状态"><RefreshCw size={12} />刷新</button>
        {status?.state !== "unsupported" && <button type="button" disabled={busy} onClick={() => { void refresh(true); }}>{busy ? "正在修复…" : healthy && status.configured && status.autoStart ? "检查并修复" : "修复共享连接"}</button>}
      </div>
    </> : <button type="button" title={status?.message} aria-label={`Codex 连接状态：${label}`} onClick={() => { void refresh(); }}>{content}</button>}
  </div>;
}
