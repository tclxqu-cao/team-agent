"use client";
// /web — remote console. Terminal IS the app (fullscreen).
// - phone: terminal fullscreen; file tree = right-edge drawer; preview = sheet
// - ≥900px: [terminal | tree | preview(only when open)] with resizable tree

import dynamic from "next/dynamic";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PanelRight, X, LayoutGrid, MonitorUp, RefreshCw } from "lucide-react";
import PwaInstallButton from "./PwaInstallButton";
import type { PinnedCommand } from "../../../core/src/domain/web-console/entities";
import { defaultPinnedCommands } from "../../../core/src/domain/web-console/pinned-commands";
import {
  WEBAPP_PROJECT_RESPONSE_TYPE,
  readWebProjectRequest,
} from "../../../core/src/domain/web-console/WebProjectBridge";
import {
  WEBAPP_BROWSER_EVENT_TYPE,
  WEBAPP_BROWSER_BINARY_FRAME_TYPE,
  WEBAPP_BROWSER_RESPONSE_TYPE,
  readWebBrowserRequest,
} from "../../../core/src/domain/web-console/WebBrowserBridge";
import { readWebArtifactOpenRequest } from "../../../core/src/domain/web-console/WebArtifactBridge";
import { WEB_SHELL_OPEN_BROWSER_LIVE_TYPE } from "../../../core/src/domain/web-console/WebShellLiveBridge";
import { readLiveFramePacket, LIVE_FRAME_PACKET_TYPE } from "../../../core/src/infrastructure/live-view/frame-packet";
import type { FileTreeRevealRequest } from "./fileTreeReveal";
import { useGateway } from "./useGateway";
import AuthGate, { type WebAuthController } from "./AuthGate";
import HistoryPanel from "./HistoryPanel";
import ThemePicker from "./ThemePicker";
import { resetHorizontalScroll, resolveVisualViewport } from "./mobileViewport";
import { DEFAULT_THEME_ID, resolveWebTheme, type WebThemeId } from "./themes";
import { readWebappTabSwipeMessage } from "./webappTabSwipe";
import { readWebappReadyMessage } from "./webappReady";

const TerminalPane = dynamic(() => import("./TerminalPane"), { ssr: false });
const FileTree = dynamic(() => import("./FileTree"), { ssr: false });
const FilePreview = dynamic(() => import("./FilePreview"), { ssr: false });
const AiHubPane = dynamic(() => import("./AiHubPane"), { ssr: false });

export default function WebConsolePage() {
  return <AuthGate>{(auth) => <AuthenticatedConsole auth={auth} />}</AuthGate>;
}

// Built-in webapp agent tab (@agent/webapp at /app) — always present, never
// deletable; "+" adds regular terminal tabs.
const WEBAPP_TAB = { id: "webapp-agent", title: "智能助手", kind: "webapp" } as const;
// AI Hub tab (multi-AI comparison workbench) — opened from the file-tree
// toolbar icon; reusable, never duplicated.
const AI_HUB_TAB = { id: "ai-hub", title: "AI Hub", kind: "aihub" } as const;
interface ConsoleTab { id: string; title: string; kind?: "webapp" | "aihub"; initialCommand?: string }

// Shell → webapp iframe skin sync; the webapp bridge listens for this type.
const WEBAPP_SKIN_MESSAGE_TYPE = "agent-web-shell:skin:v1";

function AuthenticatedConsole({ auth }: { auth: WebAuthController }) {
  const webappFrameRef = useRef<HTMLIFrameElement>(null);
  const browserFrameAck = useRef<(channelId: number, sequence: number) => void>(() => {});
  const forwardBrowserBinary = useCallback((frame: Uint8Array) => {
    const packet = readLiveFramePacket(frame);
    if (!packet || packet.type !== LIVE_FRAME_PACKET_TYPE.watcherFrame) return;
    browserFrameAck.current(packet.channelId, packet.sequence);
    const payload = packet.payload.slice().buffer;
    webappFrameRef.current?.contentWindow?.postMessage({
      type: WEBAPP_BROWSER_BINARY_FRAME_TYPE,
      channelId: packet.channelId,
      sequence: packet.sequence,
      data: payload,
    }, window.location.origin, [payload]);
  }, []);
  const { state, epoch, rpc, onEvent, onTerminalData, onTerminalReset, sendTerminalInput } = useGateway(forwardBrowserBinary, auth.getWsNonce, auth.refresh);
  browserFrameAck.current = (channelId, sequence) => {
    void rpc("browser:frame-ack", { channelId, sequence }).catch(() => undefined);
  };
  const [tabs, setTabs] = useState<ConsoleTab[]>([{ ...WEBAPP_TAB }]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(WEBAPP_TAB.id);
  const [cwdByTerminal, setCwdByTerminal] = useState<Record<string, string>>({});
  const tabsHydrated = useRef(false);
  const restoredActiveId = useRef<string|null>(null);
  const fillByTerminal = useRef(new Map<string, (command: string, submit?: boolean) => void>());
  const pendingCommandByTerminal = useRef(new Map<string, string>());
  const registerTerminalFill = useCallback((id: string, fill: (command: string, submit?: boolean) => void) => {
    fillByTerminal.current.set(id, fill);
    const timer = window.setTimeout(() => {
      if (fillByTerminal.current.get(id) !== fill) return;
      const pending = pendingCommandByTerminal.current.get(id);
      if (!pending) return;
      pendingCommandByTerminal.current.delete(id);
      fill(pending, true);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      if (fillByTerminal.current.get(id) === fill) fillByTerminal.current.delete(id);
    };
  }, []);
  const fillActiveCommand = useCallback((command: string) => {
    if (!activeTerminalId || tabs.find((tab) => tab.id === activeTerminalId)?.kind === "webapp") return;
    const fill = fillByTerminal.current.get(activeTerminalId);
    if (fill) fill(command);
    else rpc("term:input", { id: activeTerminalId, data: `\x15${command}` }).catch(() => {});
    setDrawerOpen(false);
  }, [activeTerminalId, rpc, tabs]);
  const [deviceStateLoaded, setDeviceStateLoaded] = useState(false);
  const [terminalScroll, setTerminalScroll] = useState<Record<string, number>>({});
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"files"|"history">("files");
  const [fileTreeRoot,setFileTreeRoot]=useState<string|null>(null);
  const [fileTreeFollow,setFileTreeFollow]=useState(true);
  const [fileTreeRevealRequest,setFileTreeRevealRequest]=useState<FileTreeRevealRequest|null>(null);
  const [keybarHidden,setKeybarHidden]=useState(false);
  const [keyOrder,setKeyOrder]=useState<string[]>([]);
  const [pinnedCommands,setPinnedCommands]=useState<PinnedCommand[]>(defaultPinnedCommands());
  const [themeId,setThemeId]=useState<WebThemeId>(DEFAULT_THEME_ID);
  const [preferencesLoaded,setPreferencesLoaded]=useState(false);
  const [webappReady, setWebappReady] = useState(false);
  const activeTheme = resolveWebTheme(themeId);
  const swipeStart = useRef<{ x: number; y: number; axis: "pending"|"horizontal"|"vertical"; pointerId: number } | null>(null);
  const [swipeDelta,setSwipeDelta]=useState(0);
  const [swiping,setSwiping]=useState(false);
  const draggedTab = useRef<string | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const postSkinToWebapp = useCallback((skin: WebThemeId) => {
    webappFrameRef.current?.contentWindow?.postMessage(
      { type: WEBAPP_SKIN_MESSAGE_TYPE, skin },
      window.location.origin,
    );
  }, []);
  useEffect(() => {
    postSkinToWebapp(themeId);
  }, [themeId, postSkinToWebapp]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const readyMessage = readWebappReadyMessage(
        event,
        window.location.origin,
        webappFrameRef.current?.contentWindow ?? null,
      );
      if (readyMessage) {
        setWebappReady(true);
        return;
      }
      const artifactRequest = readWebArtifactOpenRequest(
        event,
        window.location.origin,
        webappFrameRef.current?.contentWindow ?? null,
      );
      if (artifactRequest) {
        setDrawerTab("files");
        setDrawerOpen(true);
        setPreviewPath(artifactRequest.path);
        setFileTreeRevealRequest(artifactRequest);
        return;
      }
      const browserRequest = readWebBrowserRequest(
        event,
        window.location.origin,
        webappFrameRef.current?.contentWindow ?? null,
      );
      if (browserRequest) {
        void rpc(browserRequest.method, {
          ...browserRequest.payload,
          ...(browserRequest.method === "browser:watch" ? { frameAck: true } : {}),
        }).then(
          (result) => {
            webappFrameRef.current?.contentWindow?.postMessage({
              type: WEBAPP_BROWSER_RESPONSE_TYPE,
              id: browserRequest.id,
              ok: true,
              result,
            }, window.location.origin);
          },
          (error: Error & { code?: string }) => {
            webappFrameRef.current?.contentWindow?.postMessage({
              type: WEBAPP_BROWSER_RESPONSE_TYPE,
              id: browserRequest.id,
              ok: false,
              error: error.message || "浏览器操作失败",
              code: error.code,
            }, window.location.origin);
          },
        );
        return;
      }
      const request = readWebProjectRequest(
        event,
        window.location.origin,
        webappFrameRef.current?.contentWindow ?? null,
      );
      if (!request) return;
      void rpc(request.method, request.payload).then(
        (result) => {
          webappFrameRef.current?.contentWindow?.postMessage({
            type: WEBAPP_PROJECT_RESPONSE_TYPE,
            id: request.id,
            ok: true,
            result,
          }, window.location.origin);
        },
        (error: Error & { code?: string }) => {
          webappFrameRef.current?.contentWindow?.postMessage({
            type: WEBAPP_PROJECT_RESPONSE_TYPE,
            id: request.id,
            ok: false,
            error: error.message || "项目操作失败",
            code: error.code,
          }, window.location.origin);
        },
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [rpc]);
  useEffect(() => {
    const forward = (event: Record<string, unknown>) => {
      webappFrameRef.current?.contentWindow?.postMessage({
        type: WEBAPP_BROWSER_EVENT_TYPE,
        event,
      }, window.location.origin);
    };
    const eventTypes = ["browser:session", "browser:frame", "browser:state", "browser:closed", "browser:webrtc"];
    const unsubscribers = eventTypes.map((type) => onEvent(type, forward));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [onEvent]);
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

  useEffect(()=>{fetch("/api/web-console/preferences",{credentials:"same-origin"}).then(r=>r.json()).then(body=>{if(typeof body.preferences?.keybarHidden==="boolean")setKeybarHidden(body.preferences.keybarHidden);if(Array.isArray(body.preferences?.keyOrder))setKeyOrder(body.preferences.keyOrder);if(Array.isArray(body.preferences?.pinnedCommands))setPinnedCommands(body.preferences.pinnedCommands);if(body.preferences?.theme)setThemeId(resolveWebTheme(body.preferences.theme).id);}).catch(()=>{}).finally(()=>setPreferencesLoaded(true));fetch("/api/web-console/device-state",{credentials:"same-origin"}).then(r=>r.json()).then(body=>{const state=body.deviceState;if(state?.drawerTab)setDrawerTab(state.drawerTab);if(state?.activeTerminalId)restoredActiveId.current=state.activeTerminalId;if(typeof state?.drawerOpen==="boolean")setDrawerOpen(state.drawerOpen);if(state?.fileTreeRoot)setFileTreeRoot(state.fileTreeRoot);if(typeof state?.fileTreeFollowMode==="boolean")setFileTreeFollow(state.fileTreeFollowMode);if(state?.selectedFile)setPreviewPath(state.selectedFile);if(state?.terminalScroll&&typeof state.terminalScroll==="object")setTerminalScroll(state.terminalScroll);}).catch(()=>{}).finally(()=>setDeviceStateLoaded(true));},[]);
  const savePreferences=useCallback((update:Record<string,unknown>)=>{fetch("/api/web-console/preferences",{method:"PATCH",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":auth.csrfToken},body:JSON.stringify(update)}).catch(()=>{});},[auth.csrfToken]);
  useEffect(()=>{if(!preferencesLoaded)return;const timer=setTimeout(()=>savePreferences({keybarHidden,keyOrder,pinnedCommands,theme:themeId}),500);return()=>clearTimeout(timer);},[keybarHidden,keyOrder,pinnedCommands,themeId,preferencesLoaded,savePreferences]);
  const persistDeviceState=useCallback((payload:Record<string,unknown>)=>{if(!auth.csrfToken)return;fetch("/api/web-console/device-state",{method:"PUT",credentials:"same-origin",headers:{"content-type":"application/json","x-csrf-token":auth.csrfToken},body:JSON.stringify(payload)}).catch(()=>{});},[auth.csrfToken]);
  useEffect(()=>{if(!auth.csrfToken)return;const timer=setTimeout(()=>persistDeviceState({activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollowMode:fileTreeFollow,selectedFile:previewPath,terminalScroll}),500);return()=>clearTimeout(timer);},[activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollow,previewPath,terminalScroll,auth.csrfToken,persistDeviceState]);
  useEffect(()=>{if(!auth.csrfToken)return;const flush=()=>persistDeviceState({activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollowMode:fileTreeFollow,selectedFile:previewPath,terminalScroll});window.addEventListener("pagehide",flush);return()=>window.removeEventListener("pagehide",flush);},[activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollow,previewPath,terminalScroll,auth.csrfToken,persistDeviceState]);

  const openFile = useCallback((p: string) => {
    setPreviewPath(p);
    setDrawerOpen(false); // picking a file dismisses the drawer on phones
  }, []);
  const addTerminal = useCallback(() => {
    if (tabs.length >= 8) return;
    const addedId = `t-web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    setTabs((current) => {
      if (current.length >= 8) return current;
      return [...current, { id: addedId, title: `Terminal ${current.length + 1}` }];
    });
    setActiveTerminalId(addedId);
  }, [tabs.length]);

  const executeCommand = useCallback((command: string) => {
    const activeTab = tabs.find((tab) => tab.id === activeTerminalId);
    if (activeTab && activeTab.kind !== "webapp") {
      const fill = fillByTerminal.current.get(activeTab.id);
      if (fill) fill(command, true);
      else pendingCommandByTerminal.current.set(activeTab.id, command);
      setDrawerOpen(false);
      return;
    }

    const reusable = tabs.length >= 8 ? tabs.find((tab) => tab.kind !== "webapp") : null;
    const terminalId = reusable?.id ?? `t-web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (reusable) pendingCommandByTerminal.current.set(terminalId, command);
    else setTabs((current) => [...current, { id: terminalId, title: `Terminal ${current.length + 1}`, initialCommand: command }]);
    setActiveTerminalId(terminalId);
    setDrawerOpen(false);
  }, [activeTerminalId, tabs]);

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
    const closingKind = tabs.find((tab) => tab.id === id)?.kind;
    // AI Hub tab has no terminal process behind it — no confirm, no kill RPC.
    if (closingKind !== "aihub" && !window.confirm("关闭页签会终止该终端进程，确认关闭？")) return;
    // Drop the tab immediately — the kill RPC rides in the background because
    // its reply queues behind any terminal output on the same socket, and
    // waiting on it made close feel stuck (or hung until timeout).
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeTerminalId === id) setActiveTerminalId(next[0]?.id ?? null);
      return next;
    });
    if (closingKind !== "aihub") void rpc("term:kill", { id }).catch(() => {});
  };

  // 打开（或聚焦已有的）AI Hub 页签
  const openAiHubTab = useCallback(() => {
    setTabs((current) => {
      const existing = current.find((tab) => tab.kind === "aihub");
      if (existing) {
        setActiveTerminalId(existing.id);
        return current;
      }
      setActiveTerminalId(AI_HUB_TAB.id);
      return [...current, { ...AI_HUB_TAB }];
    });
  }, []);

  // 远程桌面（浏览器直播）面板由内嵌 webapp 承载；切回智能助手页签后通知它打开。
  const openWebappBrowserLive = useCallback(() => {
    setActiveTerminalId(WEBAPP_TAB.id);
    webappFrameRef.current?.contentWindow?.postMessage(
      { type: WEB_SHELL_OPEN_BROWSER_LIVE_TYPE },
      window.location.origin,
    );
  }, []);

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
  const activeContentBackground = tabs[activeIndex]?.kind === "webapp"
    ? activeTheme.cssVars["--ui-term-col-bg"]
    : activeTheme.termHostBg;
  const rootStyle = {
    ...S.root,
    ...activeTheme.cssVars,
    "--ui-active-content-bg": activeContentBackground,
    "--ui-terminal-bg": activeTheme.termHostBg,
    "--ui-primary-text": activeTheme.keybar.accentText,
    background: "var(--ui-root-bg)",
    color: "var(--ui-text)",
  } as React.CSSProperties;
  const resetSwipe=useCallback(()=>{swipeStart.current=null;setSwipeDelta(0);setSwiping(false);},[]);
  const handleTabSwipeEnd=useCallback((dx:number)=>{if(Math.abs(dx)>=64&&tabs.length>1)switchBy(dx<0?1:-1);resetSwipe();},[tabs.length,switchBy,resetSwipe]);
  const isTerminalScreen=(target:EventTarget|null)=>target instanceof Element&&!!target.closest(".terminal-screen");
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (activeTerminalId !== WEBAPP_TAB.id) return;
      const message = readWebappTabSwipeMessage(
        event,
        window.location.origin,
        webappFrameRef.current?.contentWindow ?? null,
      );
      if (!message) return;
      if (message.phase === "move") {
        setSwiping(true);
        setSwipeDelta(message.deltaX);
      } else if (message.phase === "end") {
        handleTabSwipeEnd(message.deltaX);
      } else {
        resetSwipe();
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [activeTerminalId, handleTabSwipeEnd, resetSwipe]);
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
    <div className="web-root" style={rootStyle}>
      <style dangerouslySetInnerHTML={{ __html: GLOBAL_CSS }} />

      <div className="terminal-tabs" ref={tabBarRef}>
        {tabs.map((tab) => (
          <div key={tab.id} data-terminal-id={tab.id} draggable className={`terminal-tab ${tab.id === activeTerminalId ? "active" : ""}`} onDragStart={()=>{draggedTab.current=tab.id;}} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>{event.preventDefault();const source=draggedTab.current;draggedTab.current=null;if(!source||source===tab.id)return;setTabs((current)=>{const from=current.findIndex(item=>item.id===source),to=current.findIndex(item=>item.id===tab.id);if(from<0||to<0)return current;const next=[...current];const [moved]=next.splice(from,1);next.splice(to,0,moved);rpc("term:reorder",{ids:next.map(item=>item.id).filter(itemId=>itemId!==WEBAPP_TAB.id)}).catch(()=>{});return next;});}} onClick={() => setActiveTerminalId(tab.id)} onDoubleClick={() => {
            if (tab.kind === "webapp" || tab.kind === "aihub") return;
            const title = window.prompt("页签名称", tab.title)?.trim();
            if (!title) return;
            rpc("term:rename", { id: tab.id, title }).then(() => setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, title } : item))).catch(() => {});
          }}>
            <span>{tab.title}</span>{tab.kind !== "webapp" && <button tabIndex={-1} onClick={(event) => { event.stopPropagation(); closeTerminal(tab.id); }}>×</button>}
          </div>
        ))}
        <button className="terminal-add" disabled={tabs.length >= 8} onClick={addTerminal}>＋</button>
        <div className="terminal-connection">
          <button type="button" className="file-drawer-toggle" aria-label="刷新页面" title="刷新页面" onClick={() => window.location.reload()}>
            <RefreshCw size={17} aria-hidden="true" />
          </button>
          <PwaInstallButton />
          <button
            type="button"
            className="file-drawer-toggle"
            aria-label="打开远程桌面"
            title="远程桌面 · 浏览器直播"
            onClick={openWebappBrowserLive}
          >
            <MonitorUp size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-drawer-toggle"
            aria-label="打开 AI Hub"
            title="AI Hub · 多模型对比"
            onClick={openAiHubTab}
          >
            <LayoutGrid size={17} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="file-drawer-toggle"
            aria-label={drawerOpen ? "关闭我的文件" : "打开我的文件"}
            title="我的文件"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <PanelRight size={17} aria-hidden="true" />
          </button>
          <div className="theme-avatar-with-status">
            <ThemePicker
              username={auth.user?.username ?? "?"}
              themeId={themeId}
              onThemeChange={setThemeId}
              accent={activeTheme.keybar.accent}
              accentText={activeTheme.keybar.accentText}
            />
            <span
              className="theme-avatar-status"
              data-connected={state.connected}
              aria-label={state.connected ? "已连接" : "未连接"}
            />
          </div>
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
          onPointerDownCapture={(event)=>{if(event.pointerType!=="touch"||!isTerminalScreen(event.target))return;resetSwipe();swipeStart.current={x:event.clientX,y:event.clientY,axis:"pending",pointerId:event.pointerId};}}
          onPointerMoveCapture={(event)=>{const start=swipeStart.current;if(!start||event.pointerId!==start.pointerId||event.pointerType!=="touch")return;const dx=event.clientX-start.x,dy=event.clientY-start.y;if(start.axis==="pending"){if(Math.max(Math.abs(dx),Math.abs(dy))<=8)return;if(Math.abs(dy)>=Math.abs(dx)*1.2){swipeStart.current=null;return;}start.axis="horizontal";setSwiping(true);const settle=(e:PointerEvent)=>{window.removeEventListener("pointerup",settle);window.removeEventListener("pointercancel",settle);if(swipeStart.current===start)resetSwipe();};window.addEventListener("pointerup",settle);window.addEventListener("pointercancel",settle);}if(start.axis!=="horizontal")return;event.preventDefault();setSwipeDelta(dx);}}
          onPointerUpCapture={(event)=>{const start=swipeStart.current;if(!start||event.pointerId!==start.pointerId)return;const dx=event.clientX-start.x;if(start.axis==="horizontal"&&Math.abs(dx)>=64)handleTabSwipeEnd(dx);else resetSwipe();}}
          onPointerCancelCapture={resetSwipe}
        >
          <div className="terminal-track" style={{transform:`translate3d(calc(${-activeIndex*100}% + ${swipeDelta}px),0,0)`,transition:swiping?"none":"transform 260ms cubic-bezier(.22,.8,.32,1)"}}>
          {tabs.map((tab) => (
            <div className="terminal-slide" key={tab.id} style={{ position: "relative" }}>
              {tab.kind === "webapp" ? (
                <>
                  <iframe ref={webappFrameRef} className="webapp-frame" src="/app/" title={tab.title} onLoad={() => postSkinToWebapp(themeId)} />
                  <div className={`webapp-boot${webappReady ? " is-ready" : ""}`} role="status" aria-live="polite" aria-hidden={webappReady}>
                    <div className="webapp-boot-mark" aria-hidden="true">
                      <span className="webapp-boot-orbit" />
                      <span className="webapp-boot-diamond" />
                      <span className="webapp-boot-core" />
                    </div>
                    <strong>AgentRoam</strong>
                    <span>正在唤醒工作区</span>
                  </div>
                </>
              ) : tab.kind === "aihub" ? (
                <AiHubPane visible={tab.id === activeTerminalId} rpc={rpc} />
              ) : (
                <TerminalPane terminalId={tab.id} title={tab.title} initialCommand={tab.initialCommand} visible={tab.id === activeTerminalId} state={state} rpc={rpc} onEvent={onEvent} onTerminalData={onTerminalData} onTerminalReset={onTerminalReset} sendTerminalInput={sendTerminalInput} keyOrder={keyOrder} keybarHidden={keybarHidden} onKeyOrderChange={setKeyOrder} onKeybarHiddenChange={setKeybarHidden} terminalTheme={activeTheme} initialScrollLine={terminalScroll[tab.id] ?? null} onScrollLineChange={(line) => setTerminalScroll((current) => (current[tab.id] === line ? current : { ...current, [tab.id]: line }))} onRegisterFill={(fill) => registerTerminalFill(tab.id, fill)} onCwdChange={(cwd) => cwd && setCwdByTerminal((current) => ({ ...current, [tab.id]: cwd }))} />
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
              <X size={15} aria-hidden="true" />
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
            revealRequest={fileTreeRevealRequest}
            onTreeStateChange={(root,following)=>{setFileTreeRoot(root);setFileTreeFollow(following);}}
          /> : <HistoryPanel
            csrfToken={auth.csrfToken}
            terminalId={tabs.find((tab) => tab.id === activeTerminalId)?.kind === "webapp" ? null : activeTerminalId}
            pinnedCommands={pinnedCommands}
            onPinnedCommandsChange={setPinnedCommands}
            onFill={fillActiveCommand}
            onExecute={executeCommand}
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

    </div>
  );
}

const GLOBAL_CSS = `
  html, body { width:100%; height:100%; margin:0; overflow:hidden; background:var(--ui-root-bg, #0b0b10); overscroll-behavior:none; color:var(--ui-text, #e8e8ee); }
  * { -webkit-tap-highlight-color: transparent; }
  .terminal-tabs { display:flex; align-items:end; gap:4px; min-height:38px; padding:0 8px; overflow-x:auto; overflow-y:hidden; touch-action:pan-x; overscroll-behavior-x:contain; -webkit-overflow-scrolling:touch; scroll-behavior:smooth; background:var(--ui-tabbar-bg, #12141b); border-bottom:0; scrollbar-width:none; flex-shrink:0; }
  .terminal-tab { display:flex; align-items:center; gap:7px; min-width:74px; max-width:130px; height:32px; padding:0 7px 0 10px; border-radius:7px 7px 0 0; background:var(--ui-tab-bg, #1b1e28); color:var(--ui-tab-text, #8f93a4); font-size:11px; cursor:pointer; box-sizing:border-box; transition:color .2s ease,box-shadow .2s ease; }
  .terminal-tab.active { color:var(--ui-tab-active-text, #edf0f7); background:var(--ui-active-content-bg, var(--ui-tab-active-bg, #262b38)); box-shadow:inset 0 2px var(--ui-tab-accent, #7aa2f7); }
  .terminal-tab span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .terminal-tab button { width:18px; height:18px; border:0; border-radius:4px; background:transparent; color:var(--ui-tab-text, #707586); padding:0; }
  .terminal-add { min-width:30px; height:28px; margin-bottom:2px; border:1px solid var(--ui-tabbar-border, #303442); border-radius:6px; background:var(--ui-tab-bg, #1b1e28); color:var(--ui-tab-text, #9da2b2); }
  .terminal-connection { position:sticky; right:-8px; margin-left:auto; align-self:stretch; display:flex; align-items:center; gap:7px; padding:0 9px; background:var(--ui-connection-bg, #12141b); color:var(--ui-connection-text, #777b8c); font-size:10.5px; flex-shrink:0; z-index:5; box-shadow:-8px 0 12px color-mix(in srgb, var(--ui-connection-bg, #12141b) 90%, transparent); }
  .file-drawer-toggle { display:grid; place-items:center; width:28px; height:28px; padding:0; border:0; border-radius:6px; background:transparent; color:var(--ui-connection-text, #777b8c); cursor:pointer; flex-shrink:0; touch-action:manipulation; }
  .file-drawer-toggle:hover, .file-drawer-toggle[aria-expanded="true"] { background:color-mix(in srgb, var(--ui-tab-accent, #7aa2f7) 12%, transparent); color:var(--ui-tab-active-text, #edf0f7); }
  .file-drawer-toggle:focus-visible { outline:2px solid var(--ui-tab-accent, #7aa2f7); outline-offset:-2px; }
  .theme-avatar-with-status { position:relative; display:flex; flex-shrink:0; }
  .theme-avatar-status { position:absolute; right:-2px; bottom:-2px; z-index:7; width:6px; height:6px; box-sizing:border-box; border:1px solid var(--ui-connection-bg, #12141b); border-radius:50%; background:var(--ui-error); pointer-events:none; }
  .theme-avatar-status[data-connected="true"] { background:var(--ui-success); }
  .theme-picker { position:relative; flex-shrink:0; z-index:6; }
  .theme-avatar { position:relative; display:flex; align-items:center; justify-content:center; width:18px; height:18px; padding:0; border-radius:99px; font-size:9px; font-weight:700; cursor:pointer; flex-shrink:0; touch-action:manipulation; -webkit-tap-highlight-color:transparent; transition:transform .12s ease, filter .12s ease; }
  /* Hit-area padding keeps the compact visual circle easy to target. */
  .theme-avatar::after { content:""; position:absolute; inset:-6px; border-radius:99px; }
  .theme-avatar:active { transform:scale(.9); filter:brightness(1.15); }
  .theme-popover-item { display:flex; align-items:center; gap:8px; padding:7px 8px; border:none; border-radius:8px; cursor:pointer; touch-action:manipulation; -webkit-tap-highlight-color:transparent; }
  .theme-popover-item:active { background:color-mix(in srgb, var(--ui-tab-accent, #7aa2f7) 22%, transparent); }
  /* Touch devices: grow the avatar hit area to ~44px and the popover rows to
     ~40px tall. The tab bar must grow in step — it clips overflow-y, so an
     expanded hit area taller than the bar would get cut off. */
  @media (pointer: coarse) {
    .terminal-tabs { min-height:44px; }
    .theme-avatar::after { inset:-9px; }
    .theme-popover-item { padding-top:11px; padding-bottom:11px; }
  }
  @media (prefers-reduced-motion: reduce) { .theme-avatar { transition:none; } }
  .terminal-track { display:flex; width:100%; height:100%; will-change:transform; }
  .terminal-slide { position:relative; flex:0 0 100%; width:100%; height:100%; min-width:0; overflow:hidden; }
  .webapp-frame { display:block; width:100%; height:100%; border:0; background:var(--ui-term-col-bg, #101014); }
  .webapp-boot { position:absolute; inset:0; z-index:2; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; padding:24px; box-sizing:border-box; background:var(--ui-term-col-bg, #101014); color:var(--ui-text, #e8e8ee); opacity:1; visibility:visible; pointer-events:none; transition:opacity .28s ease,visibility 0s linear 0s; }
  .webapp-boot.is-ready { opacity:0; visibility:hidden; transition:opacity .28s ease,visibility 0s linear .28s; }
  .webapp-boot strong { margin-top:15px; font-size:16px; line-height:1.25; font-weight:650; letter-spacing:0; }
  .webapp-boot > span { color:var(--ui-muted-text, #8f93a4); font-size:12px; line-height:1.5; letter-spacing:0; }
  .webapp-boot-mark { position:relative; width:66px; height:66px; color:var(--ui-tab-accent, #7aa2f7); }
  .webapp-boot-orbit { position:absolute; inset:3px; border:1px solid color-mix(in srgb,currentColor 34%,transparent); border-top-color:currentColor; border-right-color:transparent; border-radius:50%; animation:webapp-boot-spin 1.65s linear infinite; }
  .webapp-boot-diamond { position:absolute; top:19px; left:19px; width:26px; height:26px; border:2px solid currentColor; border-radius:4px; transform:rotate(45deg); animation:webapp-boot-breathe 1.35s ease-in-out infinite; }
  .webapp-boot-core { position:absolute; top:30px; left:30px; width:6px; height:6px; border-radius:50%; background:currentColor; box-shadow:0 0 0 6px color-mix(in srgb,currentColor 12%,transparent); }
  @keyframes webapp-boot-spin { to { transform:rotate(360deg); } }
  @keyframes webapp-boot-breathe { 0%,100% { opacity:.58; transform:rotate(45deg) scale(.9); } 50% { opacity:1; transform:rotate(45deg) scale(1); } }
  .terminal-surface { position:relative; flex:1; min-height:90px; overflow:hidden; }
  .terminal-screen { display:flex; flex-direction:column; width:100%; min-height:0; overflow:hidden; box-sizing:border-box; }
  .terminal-screen .xterm { flex:1; height:100%; background:var(--ui-terminal-bg, #101014); }
  .terminal-screen .xterm .xterm-viewport { background-color:var(--ui-terminal-bg, #101014); }
  .terminal-screen .xterm-scrollable-element { touch-action:pan-y; -webkit-overflow-scrolling:touch; }
  .terminal-boot { position:absolute; inset:0; z-index:46; display:flex; align-items:center; justify-content:center; gap:9px; pointer-events:auto; font-size:12px; line-height:1.4; letter-spacing:0; }
  .terminal-boot-spinner { width:16px; height:16px; box-sizing:border-box; border:2px solid color-mix(in srgb,currentColor 24%,transparent); border-top-color:currentColor; border-radius:50%; animation:terminal-boot-spin .8s linear infinite; }
  .terminal-boot-warning { position:absolute; top:9px; left:50%; z-index:45; transform:translateX(-50%); max-width:calc(100% - 24px); padding:5px 8px; border:1px solid; border-radius:6px; pointer-events:none; font-size:11px; line-height:1.35; letter-spacing:0; white-space:normal; text-align:center; }
  @keyframes terminal-boot-spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .terminal-track,.terminal-tab,.webapp-boot { transition:none !important; } .webapp-boot-orbit,.webapp-boot-diamond,.terminal-boot-spinner { animation:none !important; } }
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
  .pinned-commands { position:sticky; top:0; z-index:3; margin:-1px -1px 7px; border:1px solid var(--ui-tabbar-border, #252832); border-radius:6px; background:var(--ui-tree-bg, #121218); box-shadow:0 7px 12px color-mix(in srgb, var(--ui-root-bg, #0b0b10) 58%, transparent); overflow:hidden; }
  .pinned-command-head { display:flex; align-items:center; min-height:30px; padding:0 6px 0 10px; border-bottom:1px solid var(--ui-tabbar-border, #252832); color:var(--ui-history-meta, #74798a); font-size:10px; }
  .pinned-command-head span { flex:1; }
  .pinned-command-row { display:flex; align-items:center; min-height:34px; border-bottom:1px solid color-mix(in srgb, var(--ui-tabbar-border, #252832) 76%, transparent); cursor:pointer; outline:none; }
  .pinned-command-row:last-child { border-bottom:0; }
  .pinned-command-row:hover,.pinned-command-row:focus-visible { background:color-mix(in srgb, var(--ui-tab-active-bg, #1f2430) 76%, transparent); }
  .pinned-command-row:focus-visible { box-shadow:inset 2px 0 var(--ui-tab-accent, #7aa2f7); }
  .pinned-command-dragging { opacity:.66; background:var(--ui-tab-active-bg, #1f2430); }
  .pinned-command-row code { flex:1; min-width:0; padding:0 5px; overflow:hidden; color:var(--ui-history-item-text, #d3d6df); font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
  .pinned-command-grip { display:inline-flex; align-items:center; justify-content:center; width:28px; height:32px; padding:0; border:0; background:transparent; color:var(--ui-history-meta, #626777); cursor:grab; touch-action:none; }
  .pinned-command-grip:active { cursor:grabbing; }
  .pinned-command-actions { display:flex; align-items:center; padding-right:3px; opacity:.42; transition:opacity .15s ease; }
  .pinned-command-row:hover .pinned-command-actions,.pinned-command-row:focus-within .pinned-command-actions { opacity:1; }
  .pinned-command-editor { display:grid; grid-template-columns:minmax(0,1fr) 27px 27px; gap:4px; align-items:center; min-height:39px; padding:4px 5px 4px 8px; border-bottom:1px solid var(--ui-tabbar-border, #252832); }
  .pinned-command-editor input { min-width:0; height:27px; box-sizing:border-box; border:1px solid var(--ui-tab-accent, #536b9e); border-radius:5px; outline:none; padding:0 7px; background:var(--ui-panel-input-bg, #0f0f15); color:var(--ui-panel-input-text, #ddd); font-family:"SF Mono",Menlo,monospace; font-size:10.5px; }
  .pinned-command-editor small { grid-column:1 / -1; color:var(--ui-danger, #e06c75); font-size:9px; }
  .terminal-clipboard-notice { padding:4px 8px; flex-shrink:0; font-size:12px; }
  .terminal-native-touch, .terminal-native-touch .xterm-screen, .terminal-native-touch .terminal-native-rows, .terminal-native-touch .terminal-native-rows * { -webkit-user-select:text !important; user-select:text !important; -webkit-touch-callout:default; }
  .terminal-native-touch .terminal-native-rows { position:absolute; top:0; left:0; z-index:4; pointer-events:auto !important; }
  .terminal-native-touch .xterm-rows:not(.terminal-native-rows) { -webkit-user-select:none !important; user-select:none !important; }
  .terminal-native-touch .terminal-native-rows span { display:inline !important; }
  .terminal-native-touch .xterm-helper-textarea { opacity:1; background:transparent; color:transparent; -webkit-text-fill-color:transparent; caret-color:transparent; outline:none; text-shadow:none; -webkit-appearance:none; appearance:none; -webkit-user-select:text; user-select:text; -webkit-touch-callout:default; font-size:16px !important; left:var(--native-input-left, 0px) !important; top:var(--native-input-top, 0px) !important; width:var(--native-input-width, 80px) !important; height:var(--native-input-height, 32px) !important; z-index:10 !important; pointer-events:var(--native-input-events, none); }
  .history-search { display:flex; gap:5px; padding:5px; background:var(--ui-tree-bg, #121218); }
  .history-search input { flex:1; min-width:0; height:28px; border:1px solid var(--ui-panel-input-border, #30303a); border-radius:6px; padding:0 8px; background:var(--ui-panel-input-bg, #0f0f15); color:var(--ui-panel-input-text, #ddd); font-size:11px; }
  .history-icon-button { display:inline-flex; align-items:center; justify-content:center; width:27px; min-width:27px; height:27px; padding:0; border:1px solid var(--ui-panel-input-border, #30303a); border-radius:5px; background:var(--ui-tab-bg, #202029); color:var(--ui-connection-text, #999dab); }
  .history-icon-button:hover:not(:disabled) { color:var(--ui-drawer-tab-active, #e4e7ef); border-color:var(--ui-tab-accent, #536b9e); }
  .history-icon-button:disabled { cursor:not-allowed; opacity:.32; }
  .history-icon-danger:hover:not(:disabled) { color:var(--ui-danger, #e06c75); border-color:color-mix(in srgb, var(--ui-danger, #e06c75) 60%, var(--ui-panel-input-border, #30303a)); }
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
  @media (pointer:coarse) { .pinned-command-actions { opacity:.78; } }
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
  @media (max-width:768px), (pointer:coarse) {
    .pinned-command-editor input, .history-search input, .tree-filter input { font-size:16px; }
    .terminal-screen .xterm-helper-textarea { font-size:16px !important; }
  }
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
  .tree-disclosure {
    width: 13px;
    min-width: 13px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ui-history-meta, #777785);
  }
  .tree-entry-icon {
    width: 17px;
    min-width: 17px;
    height: 17px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .tree-folder-icon { color: var(--ui-tab-accent, #7aa2f7); }
  .tree-entry-name { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tree-spin { animation:tree-spin .8s linear infinite; }
  @keyframes tree-spin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .tree-spin { animation:none; } }
  .tree-row[data-selected="1"] { background: color-mix(in srgb, var(--ui-tab-accent, #26304a) 24%, transparent); }
  .tree-size { margin-left: auto; color: var(--ui-history-meta, #555); font-size: 10px; flex-shrink: 0; }

  /* phone-first: terminal is THE screen */
  .workspace { display: grid !important; grid-template-columns: 1fr; }
  .tree-col {
    display: flex;
    position: fixed;
    top: var(--vv-top, 0px);
    height: var(--vv-height, 100dvh);
    right: calc(100vw - var(--vv-left, 0px) - var(--vv-width, 100vw));
    width: min(82vw, 320px); z-index: 40;
    transform: translateX(102%); transition: transform .22s ease;
  }
  .tree-col-open { transform: translateX(0); box-shadow: -12px 0 32px rgba(0,0,0,.5); }
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
  .cwd-hint { max-width: 40vw; }

  @media (min-width: 900px) {
    .workspace.show-tree.has-preview { grid-template-columns: 46% 20% 34%; }
    .workspace.show-tree:not(.has-preview) { grid-template-columns: 80% 20%; }
    .workspace.has-preview:not(.show-tree) { grid-template-columns: 66% 34%; }
    /* desktop: the tree becomes a right column only while the drawer is open */
    .tree-col {
      position: static; top: auto; height: auto; width: auto; transform: none;
      box-shadow: none; border-left: 1px solid var(--ui-tree-border, #1e1e26);
    }
    .workspace:not(.show-tree) .tree-col { display: none; }
    .preview-col { position: relative; inset: auto; width: auto; height: auto; border-left: 1px solid var(--ui-tree-border, #1e1e26); }
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
    border: "1px solid var(--ui-tabbar-border, #303442)",
    background: "var(--ui-tab-bg, #202029)",
    color: "var(--ui-tab-text, #aaaab8)",
    fontSize: 13,
  },
  workspace: {
    flex: 1,
    minHeight: 0,
    display: "grid",
    position: "relative",
  },
  treeCol: {
    background: "var(--ui-tree-bg, #121218)",
    minHeight: 0,
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
  logoutBtn: { height: 24, padding: "0 8px", border: "1px solid var(--ui-muted-border, #2d303a)", borderRadius: 6, background: "var(--ui-muted-surface, #171920)", color: "var(--ui-muted-text, #8c909f)", fontSize: 10.5 },
};
