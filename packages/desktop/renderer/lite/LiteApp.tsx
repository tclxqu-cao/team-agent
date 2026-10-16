import { useEffect, useRef, useState } from "react";
import { LoaderCircle, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import type { MobilePairingInvitation } from "../../main/mobile-pairing";
import type { LiteApi } from "./api";
import { PermissionDialog } from "./PermissionDialog";

export function LiteApp({ api = window.liteApi }: { api?: LiteApi }) {
  const [invitation, setInvitation] = useState<MobilePairingInvitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在连接电脑…");
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now);
  const [permissions, setPermissions] = useState(false);
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = async () => {
    const id = ++request.current;
    setBusy(true); setError(""); setInvitation(null); setMessage("正在生成二维码…");
    try {
      const value = await api.refresh();
      if (!mounted.current || id !== request.current) return;
      setInvitation(value); setNow(Date.now());
      if (!localStorage.getItem("agentroam-lite:authorization-introduced")) {
        localStorage.setItem("agentroam-lite:authorization-introduced", "1");
        setPermissions(true);
      }
    } catch (cause) {
      if (mounted.current && id === request.current) setError(cause instanceof Error ? cause.message : "生成二维码失败，请点击刷新重试。");
    } finally { if (mounted.current && id === request.current) setBusy(false); }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => {
      setNow(Date.now());
      void api.progress().then(value => { if (mounted.current && value.phase === "installing") setMessage(value.message); }).catch(() => undefined);
    }, 1000);
    return () => { mounted.current = false; request.current++; clearInterval(timer); };
  }, [api]);
  const expired = invitation !== null && invitation.expiresAt <= now;
  return <main className="lite-shell">
    <header className="lite-brand"><Smartphone size={20} aria-hidden="true" /><span>AgentRoam <b>Lite</b></span></header>
    <h1>扫码，连接这台电脑。</h1>
    <p className="lite-description">打开手机 App 的扫码按钮，<br />或用手机相机扫描二维码。</p>
    <div className="lite-qr" aria-busy={busy}>
      {invitation && !expired ? <img src={`data:image/svg+xml,${encodeURIComponent(invitation.svg)}`} alt="AgentRoam 手机授权二维码" />
        : busy ? <div role="status"><LoaderCircle className="lite-spin" size={28} /><p>{message}</p></div>
          : <p role={error ? "alert" : "status"}>{error || "二维码已过期，请点击刷新。"}</p>}
    </div>
    <div className="lite-link" aria-label="手机配对链接">{!busy && invitation && !expired ? invitation.pairingUrl : ""}</div>
    <p className="lite-expiry">{invitation && !expired ? `一次性二维码 · ${Math.max(1, Math.ceil((invitation.expiresAt - now) / 1000))} 秒内有效` : "二维码仅限本人设备扫码"}</p>
    <div className="lite-actions"><button type="button" className="lite-primary" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />{busy ? "正在准备…" : "刷新二维码"}</button><button type="button" disabled={busy || !invitation} onClick={() => setPermissions(true)}><ShieldCheck size={16} aria-hidden="true" />重新授权</button></div>
    <footer>保持电脑在线，手机即可继续使用。</footer>
    {permissions && <PermissionDialog api={api} onClose={() => setPermissions(false)} />}
  </main>;
}
