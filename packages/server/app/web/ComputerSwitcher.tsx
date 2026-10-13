"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Camera, Check, Globe, Monitor, Pencil, Plus, X, ExternalLink, ChevronLeft, ChevronDown, ChevronRight, SlidersHorizontal, MessagesSquare, RefreshCw, MonitorUp, Palette, PanelRight, LayoutGrid, Bot, Smartphone } from "lucide-react";
import ComputerPageDialog, { type ComputerPage } from "./ComputerPageDialog";
import type { ComputerSettingsController } from "./useComputerSettings";
import type { ComputerToolId } from "../../../core/src/domain/web-console/computer-settings";
import { probeComputerAvailability, type ComputerAvailability } from "./computer-availability";
import { computerNavigation, readComputers, rememberComputer, saveComputers, pairingNavigation } from "../../public/pwa/computer-directory.js";
import { createPairingScanner, decodePairingImage, supportsLiveCamera } from "../../public/pwa/pairing-scan.js";

type Computer = { origin: string; name: string };
const TOOL_OPTIONS = [
  { id: "refresh", name: "刷新", Icon: RefreshCw },
  { id: "remote", name: "远程桌面", Icon: MonitorUp },
  { id: "theme", name: "皮肤", Icon: Palette },
  { id: "files", name: "文件树", Icon: PanelRight },
  { id: "ai-hub", name: "AI Hub", Icon: LayoutGrid },
  { id: "flow", name: "数字人", Icon: Bot },
  { id: "install", name: "添加到主屏幕", Icon: Smartphone },
] satisfies { id: ComputerToolId; name: string; Icon: typeof RefreshCw }[];

/** The outer /web shell owns this selector, so every workspace switches together. */
export default function ComputerSwitcher({ username, connected, accent, accentText, selectedPageId, onSelectPage, onUpdatePage, configuration }: {
  username: string;
  connected: boolean;
  accent: string;
  accentText: string;
  selectedPageId?: string;
  onSelectPage(page: ComputerPage | null): void;
  onUpdatePage(page: ComputerPage | null): void;
  configuration: ComputerSettingsController;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [computers, setComputers] = useState<Computer[]>([]);
  const [origin, setOrigin] = useState("");
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"home" | "computers" | "tools">("home");
  const [mobile, setMobile] = useState(false);
  const [position, setPosition] = useState({ top: 48, right: 12 });
  const [dialog, setDialog] = useState<"add" | "rename" | null>(null);
  const [pageDialog, setPageDialog] = useState<{ computer: Computer; page?: ComputerPage } | null>(null);
  const [error, setError] = useState("");
  const [availability, setAvailability] = useState<Record<string, ComputerAvailability>>({});
  const current = computers.find(computer => computer.origin === origin);
  const pages = configuration.settings.savedPages ?? [];

  useEffect(() => {
    if (configuration.loaded && selectedPageId) onUpdatePage(configuration.settings.savedPages?.find(page => page.id === selectedPageId) ?? null);
  }, [configuration.loaded, configuration.settings.savedPages, selectedPageId, onUpdatePage]);

  useEffect(() => {
    setOrigin(location.origin);
    setPortalNode(trigger.current?.closest<HTMLElement>(".web-root") ?? document.body);
    const media = window.matchMedia("(max-width: 600px)");
    const resizeMenu = () => setMobile(media.matches);
    resizeMenu(); media.addEventListener("change", resizeMenu);
    try { setComputers(saveComputers(rememberComputer(location.origin, undefined))); }
    catch (cause) { setError((cause as Error).message); }
    const refresh = () => setComputers(readComputers());
    window.addEventListener("storage", refresh);
    window.addEventListener("pageshow", refresh);
    return () => { window.removeEventListener("storage", refresh); window.removeEventListener("pageshow", refresh); media.removeEventListener("change", resizeMenu); };
  }, []);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
      if (!mobile || event.key !== "Tab") return;
      const controls = menu.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const resize = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = Math.min(292, innerWidth - 24);
      setPosition({ top: rect.bottom + 8, right: Math.max(12, Math.min(innerWidth - menuWidth - 12, innerWidth - rect.right)) });
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", resize);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); window.removeEventListener("resize", resize); };
  }, [open, mobile]);

  useEffect(() => { if (open) menu.current?.querySelector<HTMLElement>("button")?.focus(); }, [open, view]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const refresh = () => {
      for (const computer of computers) {
        if (computer.origin === origin) continue;
        void probeComputerAvailability(computer.origin, controller.signal).then(status => {
          if (!controller.signal.aborted) setAvailability(current => ({ ...current, [computer.origin]: status }));
        });
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("online", refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("online", refresh); };
  }, [open, computers, origin]);

  const closeDialog = useCallback(() => { setDialog(null); trigger.current?.focus(); }, []);
  const closePageDialog = useCallback(() => { setPageDialog(null); trigger.current?.focus(); }, []);
  const navigate = useCallback((raw: string, name: string) => {
    location.assign(pairingNavigation(raw, readComputers(), name));
  }, []);
  const rename = useCallback((name: string) => {
    setComputers(saveComputers(rememberComputer(location.origin, name)));
    closeDialog();
  }, [closeDialog]);

  return <>
    <style>{STYLES}</style>
    <div className="theme-avatar-with-status">
      <button ref={trigger} type="button" className="theme-avatar" aria-label={`电脑与连接状态（${username}）`} title={username} style={{ border: `1px solid ${accent}`, background: accent, color: accentText }} aria-expanded={open} aria-haspopup="true" onClick={() => {
        const rect = trigger.current!.getBoundingClientRect();
        const menuWidth = Math.min(292, innerWidth - 24);
        setPosition({ top: rect.bottom + 8, right: Math.max(12, Math.min(innerWidth - menuWidth - 12, innerWidth - rect.right)) });
        if (!open) { setView("home"); setError(""); void configuration.reload(); }
        setOpen(value => !value);
      }}>
        {(username.trim()[0] ?? "?").toUpperCase()}
      </button>
      <span className="theme-avatar-status" data-connected={connected} aria-label={connected ? "已连接" : "未连接"} />
    </div>
    {open && portalNode && createPortal(<div className="computer-menu-backdrop" data-toolbar-overlay>
      <div ref={menu} className="computer-menu" style={mobile ? undefined : position} role="dialog" aria-modal={mobile} aria-label={view === "tools" ? "配置顶部工具" : view === "computers" ? "选择电脑" : "电脑与保存页面"}>
      <div className="computer-menu-grip" aria-hidden="true" />
      <div className="computer-menu-heading">
        {view !== "home" && <button type="button" className="computer-close" aria-label="返回电脑菜单" onClick={() => setView("home")}><ChevronLeft size={20} /></button>}
        {view === "home" ? <button type="button" className="computer-menu-item computer-current" aria-label="选择电脑" onClick={() => setView("computers")}><Monitor size={17} /><span><strong>{current?.name || "当前电脑"}</strong><small>{connected ? "当前 · 在线" : "当前 · 未连接"}</small></span><ChevronDown size={16} /></button> : <strong>{view === "tools" ? `${current?.name || "当前电脑"} · 顶部工具` : "选择电脑"}</strong>}
        <button type="button" className="computer-close" aria-label="关闭电脑菜单" onClick={() => { setOpen(false); trigger.current?.focus(); }}><X size={20} /></button>
      </div>
      {view === "computers" && <>
      {computers.map(computer => {
        const status = computer.origin === origin ? connected ? "online" : "offline" : availability[computer.origin] ?? "checking";
        const label = status === "online" ? "在线" : status === "offline" ? "无法连接" : "检测中";
        return <button key={computer.origin} type="button" className="computer-menu-item" data-computer-origin={computer.origin} aria-label={`${computer.name}，${label}${computer.origin === origin ? "，当前电脑" : ""}`} aria-current={computer.origin === origin ? "true" : undefined} onClick={() => {
          if (computer.origin === origin) setView("home");
          else { try { location.assign(computerNavigation(computer.origin, readComputers())); } catch (cause) { setError((cause as Error).message); } }
        }}>
          <Monitor size={17} aria-hidden="true" /><span><strong>{computer.name}</strong><small>{computer.origin}</small></span><span className="computer-status-dot" data-status={status} role="img" aria-label={label} title={label} />{computer.origin === origin && <Check size={16} aria-label="当前电脑" />}
        </button>;
      })}
      <div className="computer-menu-divider" />
      <button type="button" className="computer-menu-item" onClick={() => { setOpen(false); setDialog("add"); }}><Plus size={17} aria-hidden="true" /><span>扫码添加电脑</span></button>
      <button type="button" className="computer-menu-item" onClick={() => { setOpen(false); setDialog("rename"); }}><Pencil size={16} aria-hidden="true" /><span>修改当前电脑名称</span></button>
      </>}
      {view === "home" && <>
        <div className="computer-menu-label computer-pages-heading"><span>保存的页面</span><button type="button" className="computer-page-control" aria-label="添加页面" disabled={!configuration.loaded || configuration.saving} onClick={() => { setOpen(false); setPageDialog({ computer: current ?? { origin, name: "当前电脑" } }); }}><Plus size={17} /></button></div>
        <button type="button" className="computer-menu-item" aria-current={!selectedPageId ? "true" : undefined} onClick={() => { setOpen(false); onSelectPage(null); }}><MessagesSquare size={17} /><span>电脑会话</span>{!selectedPageId && <Check size={16} />}</button>
        {pages.map(page => <div key={page.id} className="computer-menu-row">
          <button type="button" className="computer-menu-item" aria-label={`打开 ${page.name}`} aria-current={selectedPageId === page.id ? "true" : undefined} onClick={() => { setOpen(false); onSelectPage(page); }}>
            <Globe size={15} aria-hidden="true" /><span><strong>{page.name}</strong><small>{page.openMode === "current" ? "当前页面" : "新页面"} · {new URL(page.url).hostname}</small></span>{page.openMode === "new-tab" && <ExternalLink size={13} aria-hidden="true" />}
          </button>
          <button type="button" className="computer-page-control" aria-label={`编辑 ${page.name}`} disabled={configuration.saving} onClick={() => { setOpen(false); setPageDialog({ computer: current ?? { origin, name: "当前电脑" }, page }); }}><Pencil size={14} /></button>
          <button type="button" className="computer-page-control" aria-label={`删除 ${page.name}`} disabled={configuration.saving} onClick={() => { void configuration.setSavedPages(pages.filter(item => item.id !== page.id)).catch(() => {}); }}><X size={15} /></button>
        </div>)}
        <div className="computer-menu-divider" />
        <button type="button" className="computer-menu-item" onClick={() => setView("tools")}><SlidersHorizontal size={17} /><span>配置顶部工具</span><ChevronRight size={16} /></button>
      </>}
      {view === "tools" && <div className="computer-tools-list">
        {TOOL_OPTIONS.map(({ id, name, Icon }) => <label key={id} className="computer-tool-option"><Icon size={17} aria-hidden="true" /><span>{name}</span><input type="checkbox" aria-label={`显示${name}`} checked={configuration.settings.visibleTools.includes(id)} disabled={!configuration.loaded || configuration.saving} onChange={event => {
          const tools = configuration.settings.visibleTools;
          void configuration.setVisibleTools(event.target.checked ? [...tools, id] : tools.filter(tool => tool !== id)).catch(() => {});
        }} /></label>)}
      </div>}
      {view !== "computers" && <p className="computer-save-status" role="status">{!configuration.loaded ? configuration.error ? "配置尚未加载" : "正在读取电脑配置…" : configuration.saving ? "正在保存…" : configuration.notice}</p>}
      {configuration.error && view !== "computers" && <><p className="computer-error" role="alert">{configuration.error}</p><button type="button" className="computer-menu-item" onClick={() => { void configuration.reload(); }}><RefreshCw size={16} /><span>重新加载配置</span></button></>}
      {error && <p className="computer-error" role="alert">{error}</p>}
    </div></div>, portalNode)}
    {dialog && portalNode && createPortal(<ComputerDialog mode={dialog} currentName={current?.name || ""} onClose={closeDialog} onNavigate={navigate} onRename={rename} />, portalNode)}
    {pageDialog && portalNode && createPortal(<ComputerPageDialog computerName={pageDialog.computer.name} page={pageDialog.page} onClose={closePageDialog} onSave={async page => {
      if (pageDialog.page && !pages.some(item => item.id === page.id)) throw new Error("这个页面已在其他设备删除，请重新添加。");
      await configuration.setSavedPages(pageDialog.page ? pages.map(item => item.id === page.id ? page : item) : [...pages, page]);
      closePageDialog();
    }} />, portalNode)}
  </>;
}

function ComputerDialog({ mode, currentName, onClose, onNavigate, onRename }: {
  mode: "add" | "rename";
  currentName: string;
  onClose: () => void;
  onNavigate: (raw: string, name: string) => void;
  onRename: (name: string) => void;
}) {
  const [name, setName] = useState(mode === "rename" ? currentName : "");
  const nameRef = useRef(name);
  nameRef.current = name;
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const [scanning, setScanning] = useState(false);
  const [liveCamera, setLiveCamera] = useState(false);
  const [readingPhoto, setReadingPhoto] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const photoGeneration = useRef(0);
  const nameInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  const scanner = useRef<ReturnType<typeof createPairingScanner> | null>(null);
  const connect = useCallback((raw: string) => {
    scanner.current?.stop(); setScanning(false); setError("");
    try { onNavigate(raw, nameRef.current); }
    catch (cause) { setError((cause as Error).message); }
  }, [onNavigate]);

  useEffect(() => {
    setLiveCamera(supportsLiveCamera());
    if (mode === "rename") nameInput.current?.focus();
    else panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    const hidden = () => { if (document.hidden) setScanning(false); };
    document.addEventListener("keydown", escape);
    document.addEventListener("visibilitychange", hidden);
    if (mode === "add" && video.current) scanner.current = createPairingScanner(video.current, connect, (message: string) => { setScanning(false); setError(message); });
    return () => { photoGeneration.current++; document.removeEventListener("keydown", escape); document.removeEventListener("visibilitychange", hidden); scanner.current?.dispose(); scanner.current = null; };
  }, [mode, connect, onClose]);

  return <div className="computer-dialog-backdrop" data-toolbar-overlay onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={panel} className="computer-dialog" role="dialog" aria-modal="true" aria-labelledby="computer-dialog-title">
      <div className="computer-dialog-heading"><h2 id="computer-dialog-title">{mode === "add" ? "添加电脑" : "修改电脑名称"}</h2><button type="button" className="computer-close" aria-label="关闭" onClick={onClose}><X size={20} /></button></div>
      <form onSubmit={event => {
        event.preventDefault();
        if (mode === "add") connect(link);
        else { try { onRename(name.trim()); } catch (cause) { setError((cause as Error).message); } }
      }}>
        <label htmlFor="computer-name">电脑名称{mode === "add" ? "（选填）" : ""}</label>
        <input ref={nameInput} id="computer-name" maxLength={60} value={name} required={mode === "rename"} onChange={event => setName(event.target.value)} placeholder="例如：A 电脑 / 家里的电脑" autoComplete="off" />
        {mode === "add" && <>
          <p className="computer-hint">扫描另一台电脑上的 AgentRoam 授权二维码，连接后会保留已有电脑。</p>
          <input ref={photoInput} type="file" accept="image/*" capture="environment" hidden aria-label="拍摄授权二维码" onChange={async event => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            const attempt = ++photoGeneration.current;
            scanner.current?.stop(); setScanning(false); setReadingPhoto(true); setError("");
            try { const raw = await decodePairingImage(file); if (attempt === photoGeneration.current) connect(raw); }
            catch (cause) { if (attempt === photoGeneration.current) setError((cause as Error).message); }
            finally { if (attempt === photoGeneration.current) setReadingPhoto(false); }
          }} />
          <video ref={video} playsInline muted hidden={!scanning} aria-label="扫码相机画面" />
          <button className="computer-action" type="button" disabled={readingPhoto} onClick={() => {
            setError("");
            if (scanning) { scanner.current?.stop(); setScanning(false); }
            else if (!supportsLiveCamera()) photoInput.current?.click();
            else { setScanning(true); void scanner.current?.start(); }
          }}><Camera size={17} aria-hidden="true" />{readingPhoto ? "正在识别二维码…" : scanning ? "取消扫码" : liveCamera ? "打开相机扫码" : "拍照扫码"}</button>
          {liveCamera && <button className="computer-action" type="button" disabled={readingPhoto} onClick={() => { scanner.current?.stop(); setScanning(false); photoInput.current?.click(); }}>拍照识别二维码</button>}
          <label htmlFor="computer-link">或粘贴授权二维码链接</label>
          <input id="computer-link" value={link} onChange={event => setLink(event.target.value)} placeholder="http(s)://…/pair#pair=…" autoComplete="off" spellCheck={false} />
        </>}
        {error && <p className="computer-error" role="alert">{error}</p>}
        <button className="computer-action computer-primary" type="submit" disabled={mode === "add" ? !link.trim() || readingPhoto : !name.trim()}>{mode === "add" ? "连接这台电脑" : "保存名称"}</button>
      </form>
    </section>
  </div>;
}

const STYLES = `
.computer-menu-backdrop{position:fixed;inset:0;z-index:10000}
.computer-menu-heading{display:flex;align-items:center;gap:4px;padding:2px 4px}.computer-menu-heading>strong{flex:1;min-width:0;font-size:14px;font-weight:500;overflow-wrap:anywhere}.computer-menu-heading>.computer-current{flex:1;min-width:0}.computer-menu-heading>.computer-close{flex-shrink:0}
.computer-menu-grip{display:none}.computer-pages-heading{display:flex;align-items:center;justify-content:space-between}.computer-tool-option{display:flex;align-items:center;gap:12px;min-height:44px;padding:8px 12px;cursor:pointer}.computer-tool-option span{flex:1;font-size:14px}.computer-tool-option input{width:18px;height:18px;accent-color:var(--ui-tab-accent,#7aa2f7)}.computer-tool-option svg{flex-shrink:0}.computer-save-status{margin:6px 10px 2px;line-height:18px;color:var(--ui-muted-text,#999dab);font-size:12px}.computer-save-status:empty{display:none}.computer-menu button:disabled,.computer-tool-option:has(input:disabled){opacity:.55;cursor:default}
@media(max-width:600px){.computer-menu-backdrop{background:#0006}.computer-menu-backdrop .computer-menu{top:auto;bottom:0;left:0;right:0;width:100%;max-height:calc(100dvh - 64px);border-radius:18px 18px 0 0;padding:9px 10px calc(14px + env(safe-area-inset-bottom,0px));overscroll-behavior:contain}.computer-menu-grip{display:block;width:32px;height:4px;border-radius:4px;background:var(--ui-tabbar-border,#303442);margin:0 auto 10px}.computer-menu .computer-page-control,.computer-menu .computer-close{width:44px;height:44px;flex-basis:44px}.computer-menu .computer-menu-item{min-height:44px}}
.computer-menu,.computer-dialog{background:var(--ui-tree-bg,#121218);color:var(--ui-text,#e8e8ee);border:1px solid var(--ui-tabbar-border,#303442);border-radius:12px;box-shadow:0 12px 40px #0006;font-family:system-ui,sans-serif}
.computer-menu{position:fixed;z-index:10000;width:min(292px,calc(100vw - 24px));padding:7px;box-sizing:border-box;max-height:calc(100dvh - 76px);overflow-y:auto}
.computer-menu-label{padding:7px 9px;color:var(--ui-muted-text,#999dab);font-size:12px}.computer-menu-divider{height:1px;background:var(--ui-tabbar-border,#303442);margin:6px}
.computer-menu-row{display:flex;align-items:center;min-width:0;border-radius:8px}
.computer-page-row{padding-left:20px}
.computer-page-control{display:grid;place-items:center;flex:0 0 30px;width:30px;height:36px;border:0;border-radius:6px;color:var(--ui-muted-text,#999dab);background:transparent;cursor:pointer}
.computer-menu-item{display:flex;align-items:center;gap:10px;width:100%;padding:10px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.computer-menu-item svg{flex-shrink:0}.computer-menu-item span{flex:1;min-width:0;font-size:13px}.computer-menu-item strong{display:block;font-weight:500;overflow-wrap:anywhere}.computer-menu-item small{display:block;color:var(--ui-muted-text,#999dab);font-size:11px;font-weight:400;overflow-wrap:anywhere;margin-top:3px}
.computer-menu-item[aria-current=true],.computer-menu-row:has(>.computer-menu-item[aria-current=true]){background:color-mix(in srgb,var(--ui-tab-accent,#7aa2f7) 9%,transparent);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--ui-tab-accent,#7aa2f7) 22%,transparent)}
.computer-menu-item[aria-current=true]>svg{color:var(--ui-tab-accent,#7aa2f7)}.computer-menu-item[aria-current=true]>span{font-weight:600}
.computer-menu-row>.computer-menu-item{flex:1;min-width:0;background:transparent;box-shadow:none}
.computer-menu-item:focus-visible,.computer-page-control:focus-visible,.computer-close:focus-visible{outline:2px solid var(--ui-tab-accent,#7aa2f7);outline-offset:-2px}
@media(hover:hover){
  .computer-menu-item:hover,.computer-menu-row:hover{background:color-mix(in srgb,var(--ui-text,#e8e8ee) 5%,transparent)}
  .computer-menu-item[aria-current=true]:hover,.computer-menu-row:has(>.computer-menu-item[aria-current=true]):hover{background:color-mix(in srgb,var(--ui-tab-accent,#7aa2f7) 12%,transparent)}
  .computer-menu-row>.computer-menu-item:hover{background:transparent}
  .computer-page-control:hover{background:color-mix(in srgb,var(--ui-text,#e8e8ee) 7%,transparent);color:var(--ui-text,#e8e8ee)}
}
.computer-menu-item .computer-status-dot{width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--ui-connection-text,#777b8c)}.computer-status-dot[data-status=online]{background:var(--ui-success,#7dcf96)}.computer-status-dot[data-status=offline]{background:var(--ui-error,#f7768e)}
.computer-dialog-backdrop{position:fixed;inset:0;z-index:10001;background:#0008;display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.computer-dialog{width:100%;max-width:400px;max-height:calc(100dvh - 32px);overflow-y:auto;padding:20px;box-sizing:border-box}.computer-dialog-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}.computer-dialog h2{margin:0;font-size:18px;font-weight:500}.computer-close{display:grid;place-items:center;border:0;background:transparent;color:inherit;width:36px;height:36px;cursor:pointer}
.computer-dialog label{display:block;font-size:13px;margin:16px 0 8px}.computer-dialog input{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid var(--ui-panel-input-border,#30303a);border-radius:8px;background:var(--ui-panel-input-bg,#0f0f15);color:inherit;font:inherit;font-size:16px}.computer-dialog video{width:100%;max-height:240px;border-radius:8px;background:#000;margin:4px 0}.computer-dialog video[hidden]{display:none}
.computer-dialog select{width:100%;padding:11px 8px;border:1px solid var(--ui-panel-input-border,#30303a);border-radius:8px;background:var(--ui-panel-input-bg,#0f0f15);color:inherit;font:inherit;font-size:14px}
.computer-hint{color:var(--ui-muted-text,#999dab);font-size:13px;line-height:1.7}.computer-action{display:flex;align-items:center;justify-content:center;gap:8px;width:100%;padding:12px;margin-top:12px;border:1px solid var(--ui-panel-input-border,#30303a);border-radius:8px;background:var(--ui-tab-bg,#1b1e28);color:inherit;font:inherit;cursor:pointer}.computer-primary{background:var(--ui-tab-accent,#7aa2f7);color:var(--ui-root-bg,#0b0b10);border-color:transparent}.computer-action:disabled{opacity:.45;cursor:default}.computer-error{font-size:13px;line-height:1.6;color:var(--ui-danger,#ffb2a7);padding:0 8px}
@media(pointer:coarse){.computer-menu-item{min-height:44px}.computer-close{width:44px;height:44px}.computer-page-control{height:44px;flex-basis:36px;width:36px}}
`;
