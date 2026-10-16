import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, RefreshCw, Smartphone, X } from "lucide-react";
import type { MobilePairingInvitation } from "../../main/mobile-pairing";

export default function MobilePairingButton() {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="ui-icon-button desktop-app-action" title="手机扫码连接" aria-label="手机扫码连接" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Smartphone size={17} aria-hidden="true" /></button>
    {open && createPortal(<MobilePairingDialog onClose={() => setOpen(false)} />, document.body)}
  </>;
}

function MobilePairingDialog({ onClose }: { onClose(): void }) {
  const [invitation, setInvitation] = useState<MobilePairingInvitation | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    setInvitation(null); setError("");
    void window.sharedServiceApi.mobilePairing().then(value => { if (active) setInvitation(value); }, cause => { if (active) setError(cause instanceof Error ? cause.message : "生成二维码失败，请重试。"); });
    return () => { active = false; };
  }, [attempt]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const buttons = panel.current?.querySelectorAll<HTMLButtonElement>("button");
      if (!buttons?.length) return;
      const first = buttons[0], last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", keydown);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { document.removeEventListener("keydown", keydown); clearInterval(timer); previous?.focus(); };
  }, [onClose]);
  const expired = invitation && invitation.expiresAt <= now;
  return <div className="mobile-pairing-backdrop" onClick={event => { if (event.currentTarget === event.target) onClose(); }}>
    <section ref={panel} className="mobile-pairing-dialog" role="dialog" aria-modal="true" aria-labelledby="mobile-pairing-title">
      <header><h2 id="mobile-pairing-title">手机扫码连接</h2><button type="button" className="ui-icon-button" aria-label="关闭二维码" onClick={onClose}><X size={18} /></button></header>
      <p>打开 AgentRoam App，点击右上角扫码按钮，扫描下方二维码。</p>
      <div className="mobile-pairing-code" aria-busy={!invitation && !error}>
        {invitation && !expired ? <img src={`data:image/svg+xml,${encodeURIComponent(invitation.svg)}`} alt="AgentRoam 手机授权二维码" /> : error ? <p role="alert">{error}</p> : expired ? <p>二维码已过期，请刷新</p> : <LoaderCircle className="spin" size={28} aria-label="正在生成二维码" />}
      </div>
      {invitation && <small aria-label="手机配对链接">{invitation.pairingUrl}</small>}
      <p>二维码仅可使用一次，5 分钟内有效。也可使用手机相机扫码进入网页版。</p>
      <button type="button" className="mobile-pairing-refresh" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />刷新二维码</button>
    </section>
  </div>;
}
