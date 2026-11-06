import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Smartphone } from 'lucide-react';

interface Invitation { svg: string; pairingUrl: string; expiresAt: number }
export default function WebMobilePairingButton() {
  const [open, setOpen] = useState(false);
  if (!import.meta.env.DEV || !['localhost', '127.0.0.1'].includes(location.hostname)) return null;
  return <>
    <button className="ui-icon-button" aria-label="手机扫码连接" title="手机扫码连接" onClick={() => setOpen(true)}><Smartphone size={18} /></button>
    {open && <PairingDialog onClose={() => setOpen(false)} />}
  </>;
}
function PairingDialog({ onClose }: { onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { dialog.current?.showModal(); const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setInvitation(null); setError('');
    void (async () => {
      try {
        const res = await fetch('/api/local-mobile-pairing', { method: 'POST', credentials: 'same-origin', signal: controller.signal });
        const value = await res.json();
        if (!res.ok) throw new Error(value.error || '生成二维码失败');
        setInvitation(value);
      } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '生成二维码失败'); }
    })();
    return () => controller.abort();
  }, [attempt]);
  const expired = invitation && invitation.expiresAt <= now;
  return createPortal(<dialog ref={dialog} aria-labelledby="web-mobile-pairing-title" onCancel={onClose}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}
    style={{ padding: 24, borderRadius: 16, border: '1px solid #cbd5e1', width: 'min(420px, 90vw)', maxHeight: '90vh', overflow: 'auto', color: 'var(--text-primary)', background: 'var(--bg-surface, white)' }}>
    <h2 id="web-mobile-pairing-title">手机扫码连接</h2>
    <p>手机开启 MeshArc / Tailscale 后，用 Chrome 扫码或打开下方链接。</p>
    {error ? <p role="alert">{error}</p> : expired ? <p role="status">二维码已过期，请刷新。</p> : invitation
      ? <img style={{ width: '100%', maxWidth: 300, display: 'block', margin: 'auto' }} src={`data:image/svg+xml,${encodeURIComponent(invitation.svg)}`} alt="手机授权二维码" />
      : <p role="status">正在生成二维码…</p>}
    {invitation && !expired && <a href={invitation.pairingUrl} style={{ display: 'block', overflowWrap: 'anywhere', margin: '16px 0' }}>{invitation.pairingUrl}</a>}
    <p>一次有效，5 分钟后过期。请勿分享给其他人。</p>
    <button onClick={() => setAttempt(value => value + 1)}>刷新二维码</button>{' '}
    <button onClick={onClose} autoFocus>关闭</button>
  </dialog>, document.body);
}
