"use client";
// /web — remote console. Terminal IS the app (fullscreen).
// - phone: terminal fullscreen; file tree = right-edge drawer; preview = sheet
// - ≥900px: [terminal | tree | preview(only when open)] with resizable tree

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useGateway } from "./useGateway";
import AuthGate, { type WebAuthController } from "./AuthGate";
import HistoryPanel from "./HistoryPanel";
import ThemePicker from "./ThemePicker";
import { resetHorizontalScroll, resolveVisualViewport } from "./mobileViewport";
import { DEFAULT_THEME_ID, resolveWebTheme, type WebThemeId } from "./themes";

const TerminalPane = dynamic(() => import("./TerminalPane"), { ssr: false });
const FileTree = dynamic(() => import("./FileTree"), { ssr: false });
const FilePreview = dynamic(() => import("./FilePreview"), { ssr: false });

export default function WebConsolePage() {
  return <AuthGate>{(auth) => <AuthenticatedConsole auth={auth} />}</AuthGate>;
}

// Built-in webapp agent tab (@agent/webapp at /app) — always present, never
// deletable; "+" adds regular terminal tabs.
const WEBAPP_TAB = { id: "webapp-agent", title: "智能助手", kind: "webapp" } as const;

function AuthenticatedConsole({ auth }: { auth: WebAuthController }) {
  const { state, epoch, rpc, onEvent, onTerminalData, onTerminalReset, sendTerminalInput } = useGateway(() => {}, auth.getWsNonce, auth.refresh);
  const [tabs, setTabs] = useState<Array<{ id: string; title: string; kind?: "webapp" }>>([{ ...WEBAPP_TAB }]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(WEBAPP_TAB.id);
  const [cwdByTerminal, setCwdByTerminal] = useState<Record<string, string>>({});
  const tabsHydrated = useRef(false);
  const restoredActiveId = useRef<string|null>(null);
  const fillByTerminal = useRef(new Map<string, (command: string) => void>());
  const registerTerminalFill = useCallback((id: string, fill: (command: string) => void) => {
    fillByTerminal.current.set(id, fill);
    return () => fillByTerminal.current.delete(id);
  }, []);
  const fillActiveCommand = useCallback((command: string) => {
    if (!activeTerminalId) return;
    const fill = fillByTerminal.current.get(activeTerminalId);
    if (fill) fill(command);
    else rpc("term:input", { id: activeTerminalId, data: `\x15${command}` }).catch(() => {});
    setDrawerOpen(false);
  }, [activeTerminalId, rpc]);
  const [deviceStateLoaded, setDeviceStateLoaded] = useState(false);
  const [terminalScroll, setTerminalScroll] = useState<Record<string, number>>({});
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"files"|"history">("files");
  const [fileTreeRoot,setFileTreeRoot]=useState<string|null>(null);
  const [fileTreeFollow,setFileTreeFollow]=useState(true);
  const [fileButtonPosition,setFileButtonPosition]=useState({xRatio:.94,yRatio:.65,anchor:"right"});
  const [keybarHidden,setKeybarHidden]=useState(false);
  const [keyOrder,setKeyOrder]=useState<string[]>([]);
  const [themeId,setThemeId]=useState<WebThemeId>(DEFAULT_THEME_ID);
  const [preferencesLoaded,setPreferencesLoaded]=useState(false);
  const activeTheme = resolveWebTheme(themeId);
  const fileDrag=useRef<{moved:boolean}|null>(null);
  const swipeStart = useRef<{ x: number; y: number; axis: "pending"|"horizontal"|"vertical" } | null>(null);
  const [swipeDelta,setSwipeDelta]=useState(0);
  const [swiping,setSwiping]=useState(false);
  const draggedTab = useRef<string | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const prevTabCount = useRef(0);
  const cwdHint = activeTerminalId ? cwdByTerminal[activeTerminalId] ?? null : null;

  useEffect(() => {
    const vv = window.visualViewport;
    let settleTimer: number | null = null;
    let lastSignature = "";
    const syncViewport = () => {
      const viewport = resolveVisualViewport(vv, {
        height: window.innerHeight,
        width: window.innerWidth,
      });
      const signature = `${viewport.width}x${viewport.height}+${viewport.top}+${viewport.left}`;
      if (signature === lastSignature) return;
      lastSignature = signature;
      document.documentElement.style.setProperty("--vv-height", `${viewport.height}px`);
      document.documentElement.style.setProperty("--vv-width", `${viewport.width}px`);
      document.documentElement.style.setProperty("--vv-top", `${viewport.top}px`);
      document.documentElement.style.setProperty("--vv-left", `${viewport.left}px`);
      // Mobile keyboards and browser toolbars animate over several frames and
      // the last visualViewport event can land mid-transition; re-verify after
      // the motion settles so --vv-* never stays at a stale (shorter) value
      // — that stale height is what leaves blank space below the key bar.
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(syncViewport, 250);
    };
    syncViewport();
    vv?.addEventListener("resize", syncViewport);
    vv?.addEventListener("scroll", syncViewport);
    window.addEventListener("orientationchange", syncViewport);
    window.addEventListener("resize", syncViewport);
    document.addEventListener("visibilitychange", syncViewport);
    window.addEventListener("pageshow", syncViewport);
    return () => {
      vv?.removeEventListener("resize", syncViewport);
      vv?.removeEventListener("scroll", syncViewport);
      window.removeEventListener("orientationchange", syncViewport);
      window.removeEventListener("resize", syncViewport);
      document.removeEventListener("visibilitychange", syncViewport);
      window.removeEventListener("pageshow", syncViewport);
      if (settleTimer) window.clearTimeout(settleTimer);
      document.documentElement.style.removeProperty("--vv-height");
      document.documentElement.style.removeProperty("--vv-width");
      document.documentElement.style.removeProperty("--vv-top");
      document.documentElement.style.removeProperty("--vv-left");
    };
  }, []);

  useEffect(()=>{fetch("/api/web-console/preferences",{credentials:"same-origin"}).then(r=>r.json()).then(body=>{if(body.preferences?.fileButtonPosition)setFileButtonPosition(body.preferences.fileButtonPosition);if(typeof body.preferences?.keybarHidden==="boolean")setKeybarHidden(body.preferences.keybarHidden);if(Array.isArray(body.preferences?.keyOrder))setKeyOrder(body.preferences.keyOrder);if(body.preferences?.theme)setThemeId(resolveWebTheme(body.preferences.theme).id);}).catch(()=>{}).finally(()=>setPreferencesLoaded(true));fetch("/api/web-console/device-state",{credentials:"same-origin"}).then(r=>r.json()).then(body=>{const state=body.deviceState;if(state?.drawerTab)setDrawerTab(state.drawerTab);if(state?.activeTerminalId)restoredActiveId.current=state.activeTerminalId;if(typeof state?.drawerOpen==="boolean")setDrawerOpen(state.drawerOpen);if(state?.fileTreeRoot)setFileTreeRoot(state.fileTreeRoot);if(typeof state?.fileTreeFollowMode==="boolean")setFileTreeFollow(state.fileTreeFollowMode);if(state?.selectedFile)setPreviewPath(state.selectedFile);if(state?.terminalScroll&&typeof state.terminalScroll==="object")setTerminalScroll(state.terminalScroll);}).catch(()=>{}).finally(()=>setDeviceStateLoaded(true));},[]);
  const savePreferences=useCallback((update:Record<string,unknown>)=>{fetch("/api/web-console/preferences",{method:"PATCH",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":auth.csrfToken},body:JSON.stringify(update)}).catch(()=>{});},[auth.csrfToken]);
  useEffect(()=>{if(!preferencesLoaded)return;const timer=setTimeout(()=>savePreferences({fileButtonPosition,keybarHidden,keyOrder,theme:themeId}),500);return()=>clearTimeout(timer);},[fileButtonPosition,keybarHidden,keyOrder,themeId,preferencesLoaded,savePreferences]);
  const persistDeviceState=useCallback((payload:Record<string,unknown>)=>{if(!auth.csrfToken)return;fetch("/api/web-console/device-state",{method:"PUT",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":auth.csrfToken},body:JSON.stringify(payload)}).catch(()=>{});},[auth.csrfToken]);
  useEffect(()=>{if(!auth.csrfToken)return;const timer=setTimeout(()=>persistDeviceState({activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollowMode:fileTreeFollow,selectedFile:previewPath,terminalScroll}),500);return()=>clearTimeout(timer);},[activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollow,previewPath,terminalScroll,auth.csrfToken,persistDeviceState]);
  useEffect(()=>{if(!auth.csrfToken)return;const flush=()=>persistDeviceState({activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollowMode:fileTreeFollow,selectedFile:previewPath,terminalScroll});window.addEventListener("pagehide",flush);return()=>window.removeEventListener("pagehide",flush);},[activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollow,previewPath,terminalScroll,auth.csrfToken,persistDeviceState]);

  const openFile = useCallback((p: string) => {
    setPreviewPath(p);
    setDrawerOpen(false); // picking a file dismisses the drawer on phones
  }, []);
  const addTerminal = useCallback(() => {
    let addedId: string | null = null;
    setTabs((current) => {
      if (current.length >= 8) return current;
      addedId = `t-web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      return [...current, { id: addedId, title: `Terminal ${current.length + 1}` }];
    });
    if (addedId) setActiveTerminalId(addedId);
  }, []);

  useEffect(() => {
    if (!state.connected || !deviceStateLoaded || tabsHydrated.current) return;
    tabsHydrated.current = true;
    rpc<{ tabs: Array<{ id: string; title: string; status: string }> }>("term:list").then((result) => {
      const restorable = result.tabs.filter((tab) => tab.status === "active" || tab.status === "detached").map(({ id, title }) => ({ id, title }));
      setTabs([WEBAPP_TAB, ...restorable]);
      setActiveTerminalId((value) => {
        const preferred = restoredActiveId.current || value || WEBAPP_TAB.id;
        if (preferred === WEBAPP_TAB.id) return WEBAPP_TAB.id;
        return restorable.some((tab) => tab.id === preferred) ? preferred : WEBAPP_TAB.id;
      });
    }).catch(() => {});
  }, [state.connected, deviceStateLoaded, rpc]);

  const closeTerminal = (id: string) => {
    if (id === WEBAPP_TAB.id) return;
    if (!window.confirm("关闭页签会终止该终端进程，确认关闭？")) return;
    // Drop the tab immediately — the kill RPC rides in the background because
    // its reply queues behind any terminal output on the same socket, and
    // waiting on it made close feel stuck (or hung until timeout).
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeTerminalId === id) setActiveTerminalId(next[0]?.id ?? null);
      return next;
    });
    void rpc("term:kill", { id }).catch(() => {});
  };

  useEffect(() => {
    const off = onEvent("term:exited", (msg: any) => {
      const id = msg?.id;
      if (!id) return;
      // A dead process leaves its tab a silent zombie (no input, no output);
      // drop the tab as soon as the server reports the exit.
      setTabs((current) => {
        const next = current.filter((tab) => tab.id !== id);
        setActiveTerminalId((active) => (active === id ? next[0]?.id ?? null : active));
        return next;
      });
      setTerminalScroll((current) => {
        if (!(id in current)) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    });
    return () => { off(); };
  }, [onEvent]);

  const switchBy = useCallback((direction: number) => {
    if (!activeTerminalId || tabs.length < 2) return;
    const index = tabs.findIndex((tab) => tab.id === activeTerminalId);
    const nextIndex = (index + direction + tabs.length) % tabs.length;
    setActiveTerminalId(tabs[nextIndex].id);
  }, [activeTerminalId, tabs]);
  const activeIndex=Math.max(0,tabs.findIndex(tab=>tab.id===activeTerminalId));
  const resetSwipe=useCallback(()=>{swipeStart.current=null;setSwipeDelta(0);setSwiping(false);},[]);
  const handleTabSwipeEnd=useCallback((dx:number)=>{if(Math.abs(dx)>=64&&tabs.length>1)switchBy(dx<0?1:-1);resetSwipe();},[tabs.length,switchBy,resetSwipe]);
  const isTerminalScreen=(target:EventTarget|null)=>target instanceof Element&&!!target.closest(".terminal-screen");
  const scrollActiveTabIntoView = useCallback((behavior: ScrollBehavior = "smooth") => {
    const bar = tabBarRef.current;
    if (!bar || !activeTerminalId) return;
    const tab = bar.querySelector<HTMLElement>(`[data-terminal-id="${activeTerminalId}"]`);
    if (!tab) return;
    if (tab === bar.querySelector<HTMLElement>("[data-terminal-id]")) {
      resetHorizontalScroll(bar);
      return;
    }
    const connection = bar.querySelector<HTMLElement>(".terminal-connection");
    const rightInset = connection?.offsetWidth ?? 0;
    const margin = 8;
    const tabStart = tab.offsetLeft;
    const tabEnd = tabStart + tab.offsetWidth;
    const viewStart = bar.scrollLeft;
    const viewEnd = viewStart + bar.clientWidth - rightInset;
    if (tabStart < viewStart + margin) {
      bar.scrollTo({ left: Math.max(0, tabStart - margin), behavior });
    } else if (tabEnd > viewEnd - margin) {
      bar.scrollTo({ left: tabEnd - bar.clientWidth + rightInset + margin, behavior });
    }
  }, [activeTerminalId]);

  useLayoutEffect(() => {
    if (!activeTerminalId) return;
    const instant = tabs.length > prevTabCount.current;
    prevTabCount.current = tabs.length;
    scrollActiveTabIntoView(instant ? "auto" : "smooth");
  }, [activeTerminalId, tabs.length, scrollActiveTabIntoView]);

  useEffect(() => {
    const resetRestoredScroll = () => requestAnimationFrame(() => scrollActiveTabIntoView("auto"));
    window.addEventListener("pageshow", resetRestoredScroll);
    return () => window.removeEventListener("pageshow", resetRestoredScroll);
  }, [scrollActiveTabIntoView]);

  return (
    <div className="web-root" style={{ ...S.root, ...activeTheme.cssVars, background: "var(--ui-root-bg)", color: "var(--ui-text)" }}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <div className="terminal-tabs" ref={tabBarRef}>
        {tabs.map((tab) => (
          <div key={tab.id} data-terminal-id={tab.id} draggable className={`terminal-tab ${tab.id === activeTerminalId ? "active" : ""}`} onDragStart={()=>{draggedTab.current=tab.id;}} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>{event.preventDefault();const source=draggedTab.current;draggedTab.current=null;if(!source||source===tab.id)return;setTabs((current)=>{const from=current.findIndex(item=>item.id===source),to=current.findIndex(item=>item.id===tab.id);if(from<0||to<0)return current;const next=[...current];const [moved]=next.splice(from,1);next.splice(to,0,moved);rpc("term:reorder",{ids:next.map(item=>item.id).filter(itemId=>itemId!==WEBAPP_TAB.id)}).catch(()=>{});return next;});}} onClick={() => setActiveTerminalId(tab.id)} onDoubleClick={() => {
            if (tab.kind === "webapp") return;
            const title = window.prompt("页签名称", tab.title)?.trim();
            if (!title) return;
            rpc("term:rename", { id: tab.id, title }).then(() => setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, title } : item))).catch(() => {});
          }}>
            <span>{tab.title}</span>{tab.kind !== "webapp" && <button tabIndex={-1} onClick={(event) => { event.stopPropagation(); closeTerminal(tab.id); }}>×</button>}
          </div>
        ))}
        <button className="terminal-add" disabled={tabs.length >= 8} onClick={addTerminal}>＋</button>
        <div className="terminal-connection">
          <span style={{width:8,height:8,borderRadius:99,background:state.connected?"var(--ui-success)":"var(--ui-error)"}} />
          <ThemePicker
            username={auth.user?.username ?? "?"}
            themeId={themeId}
            onThemeChange={setThemeId}
            accent={activeTheme.keybar.accent}
            accentText={activeTheme.keybar.accentText}
          />
          <button style={S.logoutBtn} onClick={auth.logout} title="退出登录" aria-label="退出登录">退出</button>
        </div>
      </div>

      {/* workspace: terminal first in DOM = fullscreen by default */}
      <main
        className={`workspace ${drawerOpen ? "show-tree" : ""} ${previewPath ? "has-preview" : ""}`}
        style={S.workspace}
      >
        {/* terminal — always mounted, always the base layer */}
        <section
          className="term-col"
          style={S.termCol}
          onPointerDownCapture={(event)=>{if(event.pointerType!=="touch"||!isTerminalScreen(event.target))return;swipeStart.current={x:event.clientX,y:event.clientY,axis:"pending"};}}
          onPointerMoveCapture={(event)=>{const start=swipeStart.current;if(!start||event.pointerType!=="touch")return;const dx=event.clientX-start.x,dy=event.clientY-start.y;if(start.axis==="pending"){if(Math.max(Math.abs(dx),Math.abs(dy))<=8)return;if(Math.abs(dy)>=Math.abs(dx)*1.2){swipeStart.current=null;return;}start.axis="horizontal";setSwiping(true);}if(start.axis!=="horizontal")return;event.preventDefault();setSwipeDelta(dx);}}
          onPointerUpCapture={(event)=>{const start=swipeStart.current;if(!start||event.pointerType!=="touch")return;const dx=event.clientX-start.x;if(start.axis==="horizontal"&&Math.abs(dx)>=64)handleTabSwipeEnd(dx);else resetSwipe();}}
          onPointerCancelCapture={resetSwipe}
        >
          <div className="terminal-track" style={{transform:`translate3d(calc(${-activeIndex*100}% + ${swipeDelta}px),0,0)`,transition:swiping?"none":"transform 260ms cubic-bezier(.22,.8,.32,1)"}}>
          {tabs.map((tab) => (
            <div className="terminal-slide" key={tab.id}>
              {tab.kind === "webapp" ? (
                <iframe src="/app/" title={tab.title} style={{ width: "100%", height: "100%", border: "0", background: "#000" }} />
              ) : (
                <TerminalPane terminalId={tab.id} title={tab.title} visible={tab.id === activeTerminalId} state={state} rpc={rpc} onEvent={onEvent} onTerminalData={onTerminalData} onTerminalReset={onTerminalReset} sendTerminalInput={sendTerminalInput} keyOrder={keyOrder} keybarHidden={keybarHidden} onKeyOrderChange={setKeyOrder} onKeybarHiddenChange={setKeybarHidden} terminalTheme={activeTheme} initialScrollLine={terminalScroll[tab.id] ?? null} onScrollLineChange={(line) => setTerminalScroll((current) => (current[tab.id] === line ? current : { ...current, [tab.id]: line }))} onRegisterFill={(fill) => registerTerminalFill(tab.id, fill)} onCwdChange={(cwd) => cwd && setCwdByTerminal((current) => ({ ...current, [tab.id]: cwd }))} />
              )}
            </div>
          ))}
          </div>
        </section>

        {/* file tree — right sidebar on desktop / right drawer on phone.
            Mounted only when opened so it never steals layout space. */}
        {drawerOpen && <div className="drawer-mask" onClick={() => setDrawerOpen(false)} />}
        <aside className={`tree-col ${drawerOpen ? "tree-col-open" : ""}`} style={S.treeCol}>
          <div className="tree-head" style={S.treeHead}>
            <button className={drawerTab==="files"?"drawer-tab-active":""} onClick={()=>setDrawerTab("files")}>文件</button>
            <button className={drawerTab==="history"?"drawer-tab-active":""} onClick={()=>setDrawerTab("history")}>历史</button>
            <span className="tree-cwd" style={S.treeCwd}>{cwdHint ?? ""}</span>
            <button
              style={{ ...S.iconBtn, marginLeft: "auto", flexShrink: 0 }}
              onClick={() => setDrawerOpen(false)}
              aria-label="close drawer"
            >
              ✕
            </button>
          </div>
          {drawerTab==="files" ? <FileTree
            ready={epoch > 0}
            followCwd={true}
            cwd={cwdHint}
            rpc={rpc}
            onEvent={onEvent}
            onOpenFile={openFile}
            selectedPath={previewPath}
            initialRoot={fileTreeRoot}
            initialFollow={fileTreeFollow}
            onTreeStateChange={(root,following)=>{setFileTreeRoot(root);setFileTreeFollow(following);}}
          /> : <HistoryPanel
            csrfToken={auth.csrfToken}
            terminalId={activeTerminalId}
            onFill={fillActiveCommand}
          />}
          <div style={S.treeFoot}>
            <span style={S.treeFootDot} />
            <span>实时同步</span>
          </div>
        </aside>

        {/* preview — third column when a file is tapped */}
        {previewPath && (
          <section className="preview-col" style={S.previewCol}>
            <FilePreview path={previewPath} rpc={rpc} onClose={() => setPreviewPath(null)} />
          </section>
        )}
      </main>

      {/* floating action: toggle file drawer (both mobile & desktop) */}
      <button className="fab-files" style={{...S.fabFiles,left:`${fileButtonPosition.xRatio*100}%`,top:`${fileButtonPosition.yRatio*100}%`,right:"auto",bottom:"auto",transform:"translate(-50%,-50%)"}} onPointerDown={(event)=>{fileDrag.current={moved:false};event.currentTarget.setPointerCapture(event.pointerId);}} onPointerMove={(event)=>{if(!fileDrag.current)return;fileDrag.current.moved=true;const vv=window.visualViewport;setFileButtonPosition({xRatio:Math.max(.05,Math.min(.95,event.clientX/(vv?.width||innerWidth))),yRatio:Math.max(.08,Math.min(.92,(event.clientY-(vv?.offsetTop||0))/(vv?.height||innerHeight))),anchor:event.clientX<(vv?.width||innerWidth)/2?"left":"right"});}} onPointerUp={(event)=>{event.currentTarget.releasePointerCapture(event.pointerId);if(!fileDrag.current?.moved)setDrawerOpen(v=>!v);fileDrag.current=null;}} aria-label="files">
        📂
      </button>
    </div>
  );
}

const GLOBAL_CSS = `
  html, body { width:100%; height:100%; margin:0; overflow:hidden; background:var(--ui-root-bg, #0b0b10); overscroll-behavior:none; color:var(--ui-text, #e8e8ee); }
  * { -webkit-tap-highlight-color: transparent; }
  .terminal-tabs { display:flex; align-items:end; gap:4px; min-height:38px; padding:0 8px; overflow-x:auto; overflow-y:hidden; touch-action:pan-x; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; scroll-behavior:smooth; background:var(--ui-tabbar-bg, #12141b); border-bottom:1px solid var(--ui-tabbar-border, #282b36); scrollbar-width:none; flex-shrink:0; }
  .terminal-tab { display:flex; align-items:center; gap:7px; min-width:74px; max-width:130px; height:32px; padding:0 7px 0 10px; border-radius:7px 7px 0 0; background:var(--ui-tab-bg, #1b1e28); color:var(--ui-tab-text, #8f93a4); font-size:11px; cursor:pointer; box-sizing:border-box; transition:background .2s ease,color .2s ease,box-shadow .2s ease; }
  .terminal-tab.active { color:var(--ui-tab-active-text, #edf0f7); background:var(--ui-tab-active-bg, #262b38); box-shadow:inset 0 2px var(--ui-tab-accent, #7aa2f7); }
  .terminal-tab span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .terminal-tab button { width:18px; height:18px; border:0; border-radius:4px; background:transparent; color:var(--ui-tab-text, #707586); padding:0; }
  .terminal-add { min-width:30px; height:28px; margin-bottom:2px; border:1px solid var(--ui-tabbar-border, #303442); border-radius:6px; background:var(--ui-tab-bg, #1b1e28); color:var(--ui-tab-text, #9da2b2); }
  .terminal-connection { position:sticky; right:-8px; margin-left:auto; align-self:stretch; display:flex; align-items:center; gap:7px; padding:0 9px; background:var(--ui-connection-bg, #12141b); color:var(--ui-connection-text, #777b8c); font-size:10.5px; flex-shrink:0; z-index:5; box-shadow:-8px 0 12px color-mix(in srgb, var(--ui-connection-bg, #12141b) 90%, transparent); }
  .theme-picker { position:relative; flex-shrink:0; z-index:6; }
  .theme-avatar { -webkit-tap-highlight-color:transparent; }
  .terminal-track { display:flex; width:100%; height:100%; will-change:transform; }
  .terminal-slide { flex:0 0 100%; width:100%; height:100%; min-width:0; }
  .terminal-screen { display:flex; flex-direction:column; min-height:0; overflow:hidden; }
  .terminal-screen .xterm { flex:1; height:100%; }
  .terminal-screen .xterm-scrollable-element { touch-action:pan-y; -webkit-overflow-scrolling:touch; }
  @media (prefers-reduced-motion: reduce) { .terminal-track,.terminal-tab { transition:none !important; } }
  .web-root {
    position: fixed;
    top: var(--vv-top, 0px);
    left: var(--vv-left, 0px);
    width: var(--vv-width, 100vw);
    height: var(--vv-height, 100dvh) !important;
  }
  .tree-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    overscroll-behavior: contain;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
    padding: 6px;
  }
  .tree-location {
    position: sticky;
    top: -6px;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 5px;
    margin: -1px -1px 0;
    padding: 7px 7px 5px;
    background: color-mix(in srgb, var(--ui-tree-bg, #121218) 98%, transparent);
  }
  .tree-location input {
    flex: 1;
    min-width: 0;
    height: 28px;
    border: 1px solid var(--ui-panel-input-border, #30303b);
    border-radius: 6px;
    outline: none;
    padding: 0 8px;
    background: var(--ui-panel-input-bg, #0f0f15);
    color: var(--ui-panel-input-text, #d8d8df);
    font-family: "SF Mono", Menlo, monospace;
    font-size: 10.5px;
  }
  .tree-location input:focus { border-color: var(--ui-tab-accent, #536b9e); }
  .tree-location button {
    width: 28px;
    height: 28px;
    flex-shrink: 0;
    border: 1px solid var(--ui-panel-input-border, #30303a);
    border-radius: 6px;
    background: var(--ui-tab-bg, #202029);
    color: var(--ui-tab-text, #aaaab8);
    font-size: 12px;
  }
  .tree-location button[data-active="1"] {
    border-color: var(--ui-success, #4f6f58);
    color: var(--ui-success, #9ece6a);
    background: color-mix(in srgb, var(--ui-success, #9ece6a) 12%, var(--ui-tree-bg, #18221b));
  }
  .tree-head button { height:26px; padding:0 10px; border:0; border-radius:6px 6px 0 0; background:transparent; color:var(--ui-drawer-tab-text, #74798a); font-size:11px; }
  .tree-head button.drawer-tab-active { color:var(--ui-drawer-tab-active, #e4e7ef); box-shadow:inset 0 -2px var(--ui-tab-accent, #7aa2f7); }
  .history-panel { flex:1; min-height:0; overflow:auto; padding:7px; }
  .history-search { position:sticky; top:0; display:flex; gap:5px; padding:5px; background:var(--ui-tree-bg, #121218); z-index:2; }
  .history-search input { flex:1; min-width:0; height:28px; border:1px solid var(--ui-panel-input-border, #30303a); border-radius:6px; padding:0 8px; background:var(--ui-panel-input-bg, #0f0f15); color:var(--ui-panel-input-text, #ddd); font-size:11px; }
  .history-search button,.history-item button { border:1px solid var(--ui-panel-input-border, #30303a); border-radius:5px; background:var(--ui-tab-bg, #202029); color:var(--ui-connection-text, #999dab); font-size:10px; }
  .history-item { padding:9px 7px; border-bottom:1px solid var(--ui-tabbar-border, #242731); cursor:pointer; border-radius:6px; }
  .history-item:hover { background:color-mix(in srgb, var(--ui-tab-active-bg, #181b24) 80%, transparent); }
  .history-item:active { background:var(--ui-tab-active-bg, #1f2430); }
  .history-item-disabled { cursor:not-allowed; opacity:.55; }
  .history-item-disabled:hover { background:transparent; }
  .history-item:focus-visible { outline:1px solid var(--ui-tab-accent, #536b9e); outline-offset:-1px; }
  .history-item code { display:block; color:var(--ui-history-item-text, #d3d6df); font-size:11px; overflow-wrap:anywhere; }
  .history-item small { display:block; margin:4px 0 7px; color:var(--ui-history-meta, #656a79); font-size:9.5px; }
  .history-item-actions { display:flex; gap:5px; }
  .history-empty { padding:18px; color:#5d6270; font-size:11px; text-align:center; }
  .keybar-scroll { scrollbar-width:none; }
  .keybar-scroll::-webkit-scrollbar { display:none; }
  .tree-filter {
    position: sticky;
    top: 34px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 6px;
    margin: -1px -1px 7px;
    padding: 7px 8px;
    border-bottom: 1px solid var(--ui-tabbar-border, #25252e);
    background: color-mix(in srgb, var(--ui-tree-bg, #121218) 97%, transparent);
    color: var(--ui-history-meta, #666678);
    backdrop-filter: blur(8px);
  }
  .tree-filter input {
    flex: 1;
    min-width: 0;
    height: 27px;
    border: 1px solid var(--ui-panel-input-border, #30303a);
    border-radius: 6px;
    outline: none;
    padding: 0 8px;
    background: var(--ui-panel-input-bg, #0f0f15);
    color: var(--ui-panel-input-text, #d8d8df);
    font-size: 11px;
  }
  .tree-filter input:focus { border-color: var(--ui-tab-accent, #536b9e); }
  .tree-filter button {
    width: 25px;
    height: 25px;
    padding: 0;
    border: 0;
    border-radius: 5px;
    background: var(--ui-tab-bg, #24242d);
    color: var(--ui-connection-text, #9999a6);
    font-size: 10px;
  }
  .tree-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 31px;
    padding-right: 7px;
    border-radius: 6px;
    font-size: 12px;
    white-space: nowrap;
    cursor: pointer;
  }
  .tree-row[data-selected="1"] { background: color-mix(in srgb, var(--ui-tab-accent, #26304a) 24%, transparent); }
  .tree-size { margin-left: auto; color: var(--ui-history-meta, #555); font-size: 10px; flex-shrink: 0; }

  /* phone-first: terminal is THE screen */
  .workspace { display: grid !important; grid-template-columns: 1fr; }
  .tree-col {
    position: fixed;
    top: var(--vv-top, 0px);
    height: var(--vv-height, 100dvh);
    right: calc(100vw - var(--vv-left, 0px) - var(--vv-width, 100vw));
    width: min(82vw, 320px); z-index: 40;
    transform: translateX(102%); transition: transform .22s ease;
    box-shadow: -12px 0 32px rgba(0,0,0,.5);
  }
  .tree-col-open { transform: translateX(0); }
  .drawer-mask { position:fixed; top:var(--vv-top, 0px); left:var(--vv-left, 0px); width:var(--vv-width, 100vw); height:var(--vv-height, 100dvh); background:rgba(0,0,0,.45); z-index:39; }
  .preview-col {
    position: fixed;
    top: var(--vv-top, 0px);
    left: var(--vv-left, 0px);
    width: var(--vv-width, 100vw);
    height: var(--vv-height, 100dvh);
    z-index: 50;
    background: var(--ui-term-col-bg, #101014);
  }
  .fab-files { display: grid; place-items: center; }
  .cwd-hint { max-width: 40vw; }

  @media (min-width: 900px) {
    .workspace.has-preview { grid-template-columns: 1fr minmax(220px, 264px) minmax(320px, 34%); }
    .workspace:not(.has-preview) { grid-template-columns: 1fr minmax(220px, 264px); }
    /* desktop: tree is a persistent right column; hidden only via transform off */
    .tree-col {
      position: static; top: auto; height: auto; width: auto; transform: none;
      box-shadow: none; border-left: 1px solid var(--ui-tree-border, #1e1e26);
    }
    .workspace:not(.show-tree) .tree-col { display: none; }
    .preview-col { position: relative; inset: auto; width: auto; height: auto; border-left: 1px solid var(--ui-tree-border, #1e1e26); }
    .fab-files { display: none; }
    .drawer-mask { display: none; }
  }
`;

const S: Record<string, React.CSSProperties> = {
  root: {
    height: "100dvh",
    display: "flex",
    flexDirection: "column",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif',
    overflow: "hidden",
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "calc(env(safe-area-inset-top) + 7px) 12px 7px",
    borderBottom: "1px solid #1c1c24",
    fontSize: 13,
    flexShrink: 0,
  },
  cwdHint: {
    fontSize: 11,
    color: "#667",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    direction: "rtl" as const, // keep tail visible
    textAlign: "left" as const,
  },
  iconBtn: {
    minWidth: 28,
    height: 28,
    borderRadius: 7,
    border: "1px solid #333",
    background: "#17171d",
    color: "#ccc",
    fontSize: 13,
  },
  workspace: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "1fr",
    position: "relative",
  },
  treeCol: {
    background: "var(--ui-tree-bg, #121218)",
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
  },
  treeHead: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "10px 12px 4px",
    fontSize: 11,
    textTransform: "uppercase" as const,
    letterSpacing: 1,
    color: "#778",
    flexShrink: 0,
  },
  treeCwd: {
    fontSize: 10,
    color: "#556",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 150,
    textTransform: "none" as const,
    letterSpacing: 0,
  },
  treeFoot: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    minHeight: 31,
    padding: "6px 11px calc(env(safe-area-inset-bottom) + 6px)",
    borderTop: "1px solid var(--ui-tabbar-border, #282832)",
    boxShadow: "0 -5px 16px rgba(0,0,0,.22)",
    background: "var(--ui-tab-bg, #15151c)",
    color: "var(--ui-connection-text, #777789)",
    fontSize: 10.5,
    flexShrink: 0,
  },
  treeFootDot: {
    width: 6,
    height: 6,
    borderRadius: 99,
    background: "var(--ui-success, #9ece6a)",
    boxShadow: "0 0 0 2px color-mix(in srgb, var(--ui-success, #9ece6a) 12%, transparent)",
    flexShrink: 0,
  },
  termCol: {
    minWidth: 0,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--ui-term-col-bg, #101014)",
    gridColumn: 1,
    overflow: "hidden",
  },
  previewCol: { minWidth: 0, minHeight: 0 },
  fabFiles: {
    position: "absolute",
    right: 14,
    bottom: "calc(env(safe-area-inset-bottom) + 64px)",
    width: 44,
    height: 44,
    borderRadius: 99,
    border: "1px solid var(--ui-fab-border, #2c2c38)",
    background: "var(--ui-fab-bg, #1b1b26)",
    color: "var(--ui-text, #dde)",
    fontSize: 18,
    zIndex: 45,
    boxShadow: "0 4px 16px rgba(0,0,0,.45)",
  },
  logoutBtn: { height: 24, padding: "0 8px", border: "1px solid var(--ui-muted-border, #2d303a)", borderRadius: 6, background: "var(--ui-muted-surface, #171920)", color: "var(--ui-muted-text, #8c909f)", fontSize: 10.5 },
};
