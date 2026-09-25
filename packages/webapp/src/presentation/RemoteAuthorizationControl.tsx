import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
function MobileAuthorizationDialog({ message, showGuidance, windows, onClose }: { message: string; showGuidance: boolean; windows: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return createPortal(<dialog ref={dialog} aria-label="远程桌面提醒" onCancel={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    style={{ margin: 'auto', inset: 0, width: 'min(370px, calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', overflowY: 'auto', padding: 0, borderRadius: 12, border: '1px solid var(--border-default)', background: 'var(--bg-surface, white)', color: 'var(--text-primary)', fontSize: 14, lineHeight: 1.7 }}>
    <div style={{ padding: 20 }}>
      <strong>远程桌面提醒</strong>
      <p>{message}</p>
      {showGuidance && <>
        <p>请在电脑上打开远程桌面授权页面，点击“远程授权”（盾牌图标）。</p>
        <p>{windows ? '在 Windows 电脑上点击“开启共享”，并保持用户已登录、桌面未锁定。完成后此处会自动更新。' : '在系统设置中为 AgentRoam Remote Desktop 开启“屏幕录制”和“辅助功能”权限，然后点击“开启共享”。完成后此处会自动更新。'}</p>
      </>}
      <button type="button" className="ui-quiet-button" onClick={onClose} autoFocus>知道了</button>
    </div>
  </dialog>, document.body);
}
interface Status { platform?: string; local: boolean; supported: boolean; installed: boolean; enabled: boolean; screen: boolean; accessibility: boolean; online: boolean; locked?: boolean | null; unlock?: 'available' | 'missing' | 'unsupported'; error?: string | null }
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
  const windows = status?.platform === 'win32';
  if (!eligible) {
    if (!status || status.online && status.accessibility) return null;
    const message = !status.supported ? '这台电脑暂不支持远程桌面。'
      : !status.installed ? '电脑缺少远程桌面组件，请在电脑上升级 CLI。'
      : !status.enabled ? '电脑尚未开启桌面共享，请在电脑上完成授权并开启共享。'
      : windows && status.locked && status.unlock === 'available' ? 'Windows 已锁屏。打开「远程桌面」并选择本机桌面，即可唤醒屏幕或输入密码/PIN 解锁。'
      : windows && status.locked ? 'Windows 已锁屏，但远程解锁服务尚未安装。请在电脑上运行 agentroam unlock-service install。'
      : status.locked ? 'macOS 已锁屏。打开「远程桌面」并选择本机桌面会自动唤醒屏幕，随后可在锁屏画面输入密码。'
      : !status.screen || !status.accessibility ? windows ? 'Windows 桌面暂不可用，请检查 UAC 提示或登录状态。' : '电脑的远程桌面授权尚未完成。'
      : '电脑桌面正在连接，请稍候。';
    return <div className="remote-desktop-guidance">
      <button type="button" className="ui-icon-button" aria-label="查看远程桌面提醒" aria-haspopup="dialog" aria-expanded={expanded} onClick={() => setExpanded(true)} style={{ color: 'var(--warning, #d97706)', minWidth: 44, minHeight: 44 }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 4h.01" /></svg>
      </button>
      {expanded && <MobileAuthorizationDialog windows={windows} message={message} showGuidance={status.supported && status.installed && (!status.enabled || !status.screen || !status.accessibility)} onClose={() => setExpanded(false)} />}
    </div>;
  }
  if (!localHost) return <div style={{ position: 'relative', marginLeft: 12 }}>
    <button type="button" className="ui-icon-button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded} aria-label="远程授权" title="远程授权"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></svg></button>
    {expanded && <section aria-label="远程授权设置" style={{ position: 'absolute', top: 40, left: 0, width: 'min(370px, 70vw)', zIndex: 30, padding: 18, borderRadius: 12, background: 'var(--bg-surface, white)', border: '1px solid var(--border-default)', boxShadow: '0 10px 40px #0003', fontSize: 13 }}>
      <strong>远程授权</strong>
      <p style={{ lineHeight: 1.6 }}>请在运行 CLI 的电脑上打开终端显示的本机地址，完成配对并开启桌面共享。</p>
      <p>在电脑终端运行 <code>agentroam service status</code> 查看本机地址。</p>
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
      <p style={{ lineHeight: 1.6, margin: '10px 0' }}>{windows ? '开启后，已配对设备可查看桌面；接管后可使用鼠标和键盘。' : '在系统设置中允许「AgentRoam Remote Desktop」。屏幕录制用于手机查看，辅助功能用于鼠标键盘控制。'}</p>
      {!status.supported ? <p>目前支持 Windows 10/11 x64 和 macOS 14 及以上的 Apple Silicon 电脑。</p> : !status.installed ? <p>当前 CLI 未包含远程授权组件，请升级 CLI。</p> : <>
        {!windows && (['screen', 'accessibility'] as const).map((permission) => <div key={permission} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, margin: '12px 0' }}>
          <span>{permission === 'screen' ? '屏幕录制' : '辅助功能'}：{status[permission] ? '已授权' : '待授权'}</span>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act('authorize', permission)}>去授权</button>
        </div>)}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act(status.enabled ? 'disable' : 'enable')}>{status.enabled ? '停止共享' : '开启共享'}</button>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act('recheck')}>重新检测</button>
          <button type="button" className="ui-icon-button ui-icon-button--auto" disabled={pending} onClick={() => void act('restart')}>重启授权组件</button>
        </div>
        {windows && <p style={{ fontSize: 12, lineHeight: 1.6 }}>远程解锁服务：{status.unlock === 'available' ? '已安装，可在锁屏后远程唤醒和解锁。' : '未安装；在 Windows 终端运行 agentroam unlock-service install 后可启用。'}</p>}
        <p role="status" style={{ marginTop: 12 }}>{status.online ? '共享已开启，已配对手机可在直播列表选择本机桌面。' : status.enabled ? '等待桌面可用或首帧画面…' : '尚未开启共享。'}</p>
        <p style={{ fontSize: 12, lineHeight: 1.6 }}>{windows ? 'Windows 锁屏后直播入口会保留，可唤醒屏幕或远程解锁；UAC 安全桌面和未登录状态仍不支持控制。' : '授权后会自动继续。系统要求重新打开应用时，点击“重启授权组件”。'}</p>
      </>}
      {(error || status.error) && <p role="alert" style={{ color: 'var(--danger, #c33)' }}>{error || status.error}</p>}
    </section>}
  </div>;
}
