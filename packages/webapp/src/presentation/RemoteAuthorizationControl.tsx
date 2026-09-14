import { useEffect, useState } from 'react';
interface Status { local: boolean; supported: boolean; installed: boolean; enabled: boolean; screen: boolean; accessibility: boolean; online: boolean; error?: string | null }
export default function RemoteAuthorizationControl() {
  const [status, setStatus] = useState<Status | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const localHost = ['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname);
  const eligible = !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  useEffect(() => {

    let active = true;
    const read = async () => {
      try { const res = await fetch(eligible && localHost ? '/api/remote-authorization' : '/api/remote-authorization/status', { credentials: 'same-origin', cache: 'no-store' }); if (!res.ok) return;
        const next: Status = await res.json(); if (active) setStatus(next);
      } catch { /* Leave other live-view capabilities available while offline. */ }
    };
    void read(); const timer = setInterval(read, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [eligible, localHost]);
  if (!eligible) {
    if (!status || status.online && status.accessibility) return null;
    const message = !status.supported ? '这台电脑暂不支持远程桌面。'
      : !status.installed ? '电脑缺少远程桌面组件，请在电脑上升级 CLI。'
      : !status.enabled ? '电脑尚未开启桌面共享，请在电脑上完成授权并开启共享。'
      : !status.screen || !status.accessibility ? '电脑的远程桌面授权尚未完成。'
      : '电脑桌面正在连接，请稍候。';
    return <div className="remote-desktop-guidance" role="status" style={{ maxWidth: '100%', fontSize: 12, lineHeight: 1.6, overflowWrap: 'anywhere' }}>
      <strong>{message}</strong>
      {status.supported && status.installed && (!status.enabled || !status.screen || !status.accessibility) && <details>
        <summary>如何在电脑上授权</summary>
        <p>在运行 CLI 的电脑上，打开安装提示中的“远程桌面授权地址”，完成配对后点击“远程授权”（盾牌图标）。</p>
        <p>在系统设置中为 AgentRoam Remote Desktop 授予“屏幕录制”和“辅助功能”权限，然后点击“开启共享”。完成后此处会自动更新。</p>
      </details>}
    </div>;
  }
  if (!localHost) return <div style={{ position: 'relative', marginLeft: 12 }}>
    <button type="button" className="ui-icon-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label="远程授权" title="远程授权"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></svg></button>
    {expanded && <section aria-label="远程授权设置" style={{ position: 'absolute', top: 40, left: 0, width: 'min(370px, 70vw)', zIndex: 30, padding: 18, borderRadius: 12, background: 'var(--bg-surface, white)', border: '1px solid var(--border-default)', boxShadow: '0 10px 40px #0003', fontSize: 13 }}>
      <strong>远程授权</strong>
      <p style={{ lineHeight: 1.6 }}>请在运行 CLI 的电脑上打开本机页面，完成配对后设置屏幕录制和辅助功能权限。</p>
      <button type="button" className="ui-icon-button ui-icon-button--auto" style={{ padding: '10px 16px', background: 'var(--accent, #5264ff)', color: '#fff', borderRadius: 8 }} onClick={() => window.open(`http://127.0.0.1:${location.port || '3000'}/web`, '_blank', 'noopener,noreferrer')}>打开本机授权页面</button>
      <p style={{ lineHeight: 1.6 }}>如果你正在另一台电脑上查看，请到运行 CLI 的电脑操作。授权完成后，可回到当前页面查看画面。</p>
    </section>}
  </div>;
  if (!status?.local) return null;
  const act = async (action: string, permission?: string) => {
    setPending(true); setError('');
    try {
      const res = await fetch('/api/remote-authorization', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, permission }) });
      const result = await res.json(); if (!res.ok) throw new Error(result.error || '操作失败'); setStatus(result);
    } catch (error) { setError(error instanceof Error ? error.message : '操作失败'); }
    finally { setPending(false); }
  };
  return <div style={{ position: 'relative', marginLeft: 12 }}>
    <button type="button" className="ui-icon-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label="远程授权" title="远程授权"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></svg></button>
    {expanded && <section aria-label="远程授权设置" style={{ position: 'absolute', top: 40, left: 0, width: 'min(370px, 70vw)', zIndex: 30, padding: 18, borderRadius: 12, background: 'var(--bg-surface, white)', color: 'var(--text-primary)', border: '1px solid var(--border-default)', boxShadow: '0 10px 40px #0003', fontSize: 13 }}>
      <strong>远程授权</strong>
      <p style={{ lineHeight: 1.6, margin: '10px 0' }}>在系统设置中允许「AgentRoam Remote Desktop」。屏幕录制用于手机查看，辅助功能用于鼠标键盘控制。</p>
      {!status.supported ? <p>目前支持 macOS 14 及以上的 Apple Silicon 电脑。</p> : !status.installed ? <p>当前 CLI 未包含远程授权组件，请升级 CLI。</p> : <>
        {(['screen', 'accessibility'] as const).map((permission) => <div key={permission} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '12px 0' }}>
          <span>{permission === 'screen' ? '屏幕录制' : '辅助功能'}：{status[permission] ? '已授权' : '待授权'}</span>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act('authorize', permission)}>去授权</button>
        </div>)}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act(status.enabled ? 'disable' : 'enable')}>{status.enabled ? '停止共享' : '开启共享'}</button>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act('recheck')}>重新检测</button>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act('restart')}>重启授权组件</button>
        </div>
        <p role="status" style={{ marginTop: 12 }}>{status.online ? '共享已开启，已配对手机可在直播列表选择本机桌面。' : status.enabled ? '等待系统授权或首帧画面…' : '尚未开启共享。'}</p>
        <p style={{ fontSize: 12, lineHeight: 1.6 }}>授权后会自动继续。系统要求重新打开应用时，点击“重启授权组件”。</p>
      </>}
      {(error || status.error) && <p role="alert" style={{ color: 'var(--danger, #c33)' }}>{error || status.error}</p>}
    </section>}
  </div>;
}
