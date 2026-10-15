import { useEffect, useRef, useState, type CSSProperties, type SyntheticEvent } from "react";
import { ArrowUp, Bot, Camera, ChevronLeft, LayoutGrid, Menu, MonitorUp, Palette, PanelRight, Plus, RefreshCw, UsersRound } from "lucide-react";
import ResponsiveToolbar from "../../../../server/app/web/ResponsiveToolbar";
import WorkspaceBoot from "../../../../server/app/web/WorkspaceBoot";
import { CONSOLE_CSS } from "../../../../server/app/web/console-styles";
import { resolveWebTheme } from "../../../../server/app/web/themes";
import EmptySessionWelcome from "../../../../desktop/renderer/components/EmptySessionWelcome";
import AgentWorkspaceSwitcher from "../../../../desktop/renderer/components/AgentWorkspaceSwitcher";
import "./unpaired-home.css";

const SCAN_HINT = "请点击扫码按钮扫码";
const TOOLS = [
  ["刷新页面", RefreshCw], ["打开群聊看板", UsersRound], ["打开远程桌面", MonitorUp],
  ["打开 AI Hub", LayoutGrid], ["打开数字人", Bot], ["皮肤", Palette], ["打开我的文件", PanelRight],
] as const;

/** This surface has no gateway, subscriptions, or saved workspace data. */
export default function UnpairedHome({ onScan, initialFailure = "" }: { onScan(): Promise<void>; initialFailure?: string }) {
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState(initialFailure);
  const [booted, setBooted] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    const boot = setTimeout(() => setBooted(true), 650);
    return () => { clearTimeout(boot); clearTimeout(timer.current); };
  }, []);
  const hint = () => {
    setMessage(SCAN_HINT);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), 3000);
  };
  const block = (event: SyntheticEvent) => {
    if ((event.target as Element).closest("[data-pairing-action]")) return;
    event.preventDefault(); event.stopPropagation(); hint();
  };
  const scan = async () => {
    if (scanning) return;
    clearTimeout(timer.current); setScanning(true); setMessage("");
    try { await onScan(); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "扫码连接失败，请重试。"); }
    finally { setScanning(false); }
  };
  const theme = resolveWebTheme("pearl");
  return <div className="web-root unpaired-home" style={theme.cssVars as CSSProperties} onClickCapture={block} onKeyDownCapture={event => { if (event.key === "Enter" || event.key === " ") block(event); }}>
    <style dangerouslySetInnerHTML={{ __html: CONSOLE_CSS }} />
    <div className="terminal-tabs">
      <div className="terminal-tab-list"><div className="terminal-tab active" role="tab" aria-disabled="true"><span>智能助手</span></div></div>
      <button type="button" className="terminal-add" aria-label="新建终端页签" aria-disabled="true">＋</button>
      <div className="terminal-connection"><ResponsiveToolbar
        items={TOOLS.map(([label, Icon]) => ({ id: label, content: <button type="button" className="file-drawer-toggle" aria-label={label} aria-disabled="true"><Icon size={17} /></button> }))}
        avatar={<button type="button" data-pairing-action className="unpaired-scan" aria-label="扫码连接电脑" title="扫码连接电脑" disabled={scanning} onClick={() => void scan()}><Camera size={19} /><span>{scanning ? "连接中" : "扫码"}</span></button>}
      /></div>
    </div>
    <main className="unpaired-workspace" aria-label="尚未连接电脑的工作区">
      <header className="unpaired-workspace-header"><button type="button" className="ui-icon-button" aria-label="会话列表" aria-disabled="true"><Menu size={18} /></button><span>智能助手</span><button type="button" className="ui-icon-button" aria-label="返回" aria-disabled="true"><ChevronLeft size={17} /></button></header>
      <div className="unpaired-agent-switcher"><AgentWorkspaceSwitcher value="codex" health={[]} onChange={hint} onUnavailable={hint} /></div>
      <div className="unpaired-welcome"><EmptySessionWelcome agentType="codex" ready={true} connectionRequired onSelectPrompt={hint} /></div>
      <div className="unpaired-composer"><span>发送消息…</span><div><button type="button" className="ui-icon-button" aria-label="添加附件" aria-disabled="true"><Plus size={19} /></button><button type="button" className="ui-icon-button" aria-label="发送消息" aria-disabled="true"><ArrowUp size={19} /></button></div></div>
    </main>
    {message && <p className="unpaired-notice" role="alert">{message}</p>}
    <WorkspaceBoot ready={booted} />
  </div>;
}
