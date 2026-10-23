"use client";
// /web — remote console. Terminal IS the app (fullscreen).
// - phone: terminal fullscreen; file tree = right-edge drawer; preview = sheet
// - ≥900px: [terminal | tree | preview(only when open)] with resizable tree

import dynamic from "next/dynamic";
import { CONSOLE_CSS } from "./console-styles";
import { consoleFrameUrl, consoleOrigin } from "./console-environment";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ExternalLink, Bot, PanelRight, X, LayoutGrid, MonitorUp, RefreshCw, UsersRound } from "lucide-react";
import PwaInstallButton from "./PwaInstallButton";
import ComputerSwitcher from "./ComputerSwitcher";
import ComputerPagePane from "./ComputerPagePane";
import type { ComputerPage } from "./ComputerPageDialog";
import ResponsiveToolbar from "./ResponsiveToolbar";
import { useComputerSettings } from "./useComputerSettings";
import type { FileWorkspaceGateway } from "../../../core/src/application/file-workspace/FileWorkspaceGateway";
import type { PinnedCommand } from "../../../core/src/domain/web-console/entities";
import { defaultPinnedCommands } from "../../../core/src/domain/web-console/pinned-commands";
import { forwardWebProjectRequest } from "./projectFrameBridge";
import {
  WEBAPP_BROWSER_EVENT_TYPE,
  WEBAPP_BROWSER_BINARY_FRAME_TYPE,
  WEBAPP_BROWSER_RESPONSE_TYPE,
  readWebBrowserRequest,
} from "../../../core/src/domain/web-console/WebBrowserBridge";
import { isWebMediaUrl, readWebArtifactOpenRequest } from "../../../core/src/domain/web-console/WebArtifactBridge";
import { readWebShellOpenBrowserLive } from "../../../core/src/domain/web-console/WebShellLiveBridge";
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
import { readCollaborationChanged, readCollaborationOpen } from "../../../core/src/domain/web-console/CollaborationTabBridge";

import FlowStudioLoading from "./FlowStudioLoading";
import CollaborationPane from "./CollaborationPane";
import { COLLABORATION_DASHBOARD_TAB, withCollaborationDashboard, REMOTE_DESKTOP_TAB, withRemoteDesktopTab, parseWorkspaceSnapshot, restoreWorkspaceTabs, type ConsoleTab } from "./console-tabs";
import { readRemoteDesktopFullscreen, REMOTE_DESKTOP_CLOSE_TYPE, REMOTE_DESKTOP_VISIBILITY_TYPE, REMOTE_DESKTOP_CONTENT_READY_TYPE } from "../../../core/src/domain/web-console/RemoteDesktopTabBridge";
import { resolveWebArtifactPath } from "../../../desktop/renderer/lib/artifact-links";

const TerminalPane = dynamic(() => import("./TerminalPane"), { ssr: false });
const FileTree = dynamic(() => import("./FileTree"), { ssr: false });
const FilePreview = dynamic(() => import("./FilePreview"), { ssr: false });
const AiHubPane = dynamic(() => import("./AiHubPane"), { ssr: false });
const FlowStudioPane = dynamic(() => import("./FlowStudioPane"), { ssr: false, loading: () => <FlowStudioLoading /> });

export default function WebConsolePage() {
  return (
    <AuthGate>
      {(auth, onWorkspaceReady) => (
        <AuthenticatedConsole auth={auth} onWorkspaceReady={onWorkspaceReady} />
      )}
    </AuthGate>
  );
}

// Built-in webapp agent tab (@agent/webapp at /app) — always present, never
// deletable; "+" adds regular terminal tabs.
const WEBAPP_TAB = { id: "webapp-agent", title: "智能助手", kind: "webapp" } as const;
// AI Hub tab (multi-AI comparison workbench) — opened from the tab-bar icon;
// reusable, never duplicated.
const AI_HUB_TAB = { id: "ai-hub", title: "AI Hub", kind: "aihub" } as const;
const FLOW_STUDIO_TAB = { id: "flow-studio", title: "Flow Studio", kind: "flowstudio" } as const;


function readInitialWebThemeId(): WebThemeId {
  if (typeof document === "undefined") return DEFAULT_THEME_ID;
  return resolveWebTheme(document.getElementById("web-theme-root")?.dataset.webTheme).id;
}

// Shell → webapp iframe skin sync; the webapp bridge listens for this type.
const WEBAPP_SKIN_MESSAGE_TYPE = "agent-web-shell:skin:v1";

function AuthenticatedConsole({
  auth,
  onWorkspaceReady,
}: {
  auth: WebAuthController;
  onWorkspaceReady: () => void;
}) {
  const [selectedPage, setSelectedPage] = useState<ComputerPage | null>(null);
  const [pageReloadKey, setPageReloadKey] = useState(0);
  const selectComputerPage = useCallback((page: ComputerPage | null) => {
    if (page?.openMode === "new-tab") { window.open(page.url, "_blank", "noopener,noreferrer"); return; }
    setSelectedPage(page);
  }, []);
  const updateComputerPage = useCallback((page: ComputerPage | null) => setSelectedPage(page?.openMode === "current" ? page : null), []);
  const webappFrameRef = useRef<HTMLIFrameElement>(null);
  const remoteDesktopFrameRef = useRef<HTMLIFrameElement>(null);
  const collaborationDashboardFrame = useRef<HTMLIFrameElement | null>(null);
  const [collaborationFrameRevisions, setCollaborationFrameRevisions] = useState<Record<string, number>>({});
  const collaborationFrames = useRef(new Map<string, HTMLIFrameElement>());
  const [remoteDesktopReadyEpoch, setRemoteDesktopReadyEpoch] = useState(0);
  const [remoteDesktopFullscreen, setRemoteDesktopFullscreen] = useState(false);
  const [remoteDesktopContentReady, setRemoteDesktopContentReady] = useState(false);
  const browserFrameAck = useRef<(channelId: number, sequence: number) => void>(() => {});
  const forwardBrowserBinary = useCallback((frame: Uint8Array) => {
    const packet = readLiveFramePacket(frame);
    if (!packet || packet.type !== LIVE_FRAME_PACKET_TYPE.watcherFrame) return;
    browserFrameAck.current(packet.channelId, packet.sequence);
    for (const ref of [webappFrameRef, remoteDesktopFrameRef]) {
      if (!ref.current?.contentWindow) continue;
      const payload = packet.payload.slice().buffer;
      ref.current.contentWindow.postMessage({
        type: WEBAPP_BROWSER_BINARY_FRAME_TYPE,
        channelId: packet.channelId,
        sequence: packet.sequence,
        data: payload,
      }, window.location.origin, [payload]);
    }
  }, []);
  const { state, epoch, rpc, onEvent, onTerminalData, onTerminalReset, sendTerminalInput } = useGateway(forwardBrowserBinary, auth.getWsNonce, auth.refresh);
  const fileWorkspaceGateway = useMemo<FileWorkspaceGateway>(() => ({
    request: <T,>(
      method: Parameters<FileWorkspaceGateway["request"]>[0],
      params?: Record<string, unknown>,
      timeoutMs?: number,
    ) => rpc<T>(method, params, timeoutMs),
    subscribe: (_type, listener) => onEvent("fs:event", listener),
  }), [onEvent, rpc]);
  browserFrameAck.current = (channelId, sequence) => {
    void rpc("browser:frame-ack", { channelId, sequence }).catch(() => undefined);
  };
  const [tabs, setTabs] = useState<ConsoleTab[]>([{ ...WEBAPP_TAB }]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(WEBAPP_TAB.id);
  const [cwdByTerminal, setCwdByTerminal] = useState<Record<string, string>>({});
  const tabsHydrated = useRef(false);
  const [workspaceRestored, setWorkspaceRestored] = useState(false);
  const [workspaceRestoreAttempt, setWorkspaceRestoreAttempt] = useState(0);
  const workspaceStorageKey = `agentroam:workspace:${typeof window === "undefined" ? "" : consoleOrigin()}:${auth.user?.id ?? ""}`;
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
    if (!activeTerminalId || tabs.find((tab) => tab.id === activeTerminalId)?.kind) return;
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
  const [themeId,setThemeId]=useState<WebThemeId>(readInitialWebThemeId);
  const [preferencesLoaded,setPreferencesLoaded]=useState(false);
  const computerConfiguration = useComputerSettings(auth.csrfToken);
  const [webappReady, setWebappReady] = useState(false);
  const activeTheme = resolveWebTheme(themeId);
  const swipeStart = useRef<{ x: number; y: number; axis: "pending"|"horizontal"|"vertical"; pointerId: number } | null>(null);
  const [swipeDelta,setSwipeDelta]=useState(0);
  const [swiping,setSwiping]=useState(false);
  const draggedTab = useRef<string | null>(null);
  const tabBarRef = useRef<HTMLDivElement>(null);
  const postSkinToWebapp = useCallback((skin: WebThemeId) => {
    const frames = [webappFrameRef.current, remoteDesktopFrameRef.current, collaborationDashboardFrame.current, ...collaborationFrames.current.values()];
    for (const frame of frames) frame?.contentWindow?.postMessage(
      { type: WEBAPP_SKIN_MESSAGE_TYPE, skin },
      window.location.origin,
    );
  }, []);
  useEffect(() => {
    postSkinToWebapp(themeId);
  }, [themeId, postSkinToWebapp]);
  // Keep the OS chrome on the active skin: iOS home-screen apps paint the
  // status-bar strip with the page background, Android tints it from the
  // theme-color meta. The tint follows the top tab bar so the strip reads as
  // one surface with it.
  useEffect(() => {
    const rootBg = activeTheme.cssVars["--ui-root-bg"];
    const colorScheme = activeTheme.cssVars["--ui-color-scheme"];
    const themeRoot = document.getElementById("web-theme-root");
    for (const [name, value] of Object.entries(activeTheme.cssVars)) {
      themeRoot?.style.setProperty(name, value);
    }
    if (themeRoot) themeRoot.dataset.webTheme = activeTheme.id;
    document.documentElement.style.background = rootBg;
    document.documentElement.style.colorScheme = colorScheme;
    document.body.style.background = rootBg;
    document.body.style.colorScheme = colorScheme;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.append(meta);
    }
    meta.content = activeTheme.cssVars["--ui-tabbar-bg"];
  }, [activeTheme]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const dashboardSource = collaborationDashboardFrame.current?.contentWindow ?? null;
      const changed = readCollaborationChanged(event, window.location.origin, dashboardSource);
      if (changed) {
        setTabs(current => changed.deleted
          ? current.filter(tab => tab.groupId !== changed.groupId)
          : current.map(tab => tab.groupId === changed.groupId ? { ...tab, title: changed.title! } : tab));
        if (changed.deleted) setActiveTerminalId(current => current === `collaboration-${changed.groupId}` ? COLLABORATION_DASHBOARD_TAB.id : current);
        else setCollaborationFrameRevisions(current => ({ ...current, [changed.groupId]: (current[changed.groupId] || 0) + 1 }));
        return;
      }
      const groupRequest = readCollaborationOpen(event, window.location.origin,
        event.source === dashboardSource ? dashboardSource : webappFrameRef.current?.contentWindow ?? null);
      if (groupRequest) {
        const id = `collaboration-${groupRequest.groupId}`;
        setTabs(current => current.some(tab => tab.id === id) ? current : [...current, {id, title: groupRequest.title, kind: "collaboration", groupId: groupRequest.groupId}]);
        setActiveTerminalId(id);
        return;
      }
      const remoteSource = remoteDesktopFrameRef.current?.contentWindow ?? null;
      const fullscreen = readRemoteDesktopFullscreen(event, window.location.origin, remoteSource);
      if (fullscreen !== null) {
        setRemoteDesktopFullscreen(fullscreen);
        return;
      }
      if (readWebappReadyMessage(event, window.location.origin, remoteSource)) {
        setRemoteDesktopFullscreen(false);
        setRemoteDesktopReadyEpoch((current) => current + 1);
        setRemoteDesktopContentReady(false);
        postSkinToWebapp(themeId);
        return;
      }
      if (remoteSource && event.origin === window.location.origin && event.source === remoteSource && event.data?.type === REMOTE_DESKTOP_CONTENT_READY_TYPE) {
        setRemoteDesktopContentReady(true);
        return;
      }
      if (event.origin === window.location.origin && event.source === remoteSource && remoteSource && event.data?.type === REMOTE_DESKTOP_CLOSE_TYPE) {
        setRemoteDesktopFullscreen(false);
        void rpc("browser:unwatch").catch(() => {});
        setTabs((current) => current.filter((tab) => tab.kind !== "remote-desktop"));
        setRemoteDesktopReadyEpoch(0);
        setRemoteDesktopContentReady(false);
        setActiveTerminalId(WEBAPP_TAB.id);
        return;
      }
      if (readWebShellOpenBrowserLive(event, window.location.origin, webappFrameRef.current?.contentWindow ?? null)) {
        setTabs(withRemoteDesktopTab);
        setActiveTerminalId(REMOTE_DESKTOP_TAB.id);
        return;
      }
      const readyMessage = readWebappReadyMessage(
        event,
        window.location.origin,
        webappFrameRef.current?.contentWindow ?? null,
      );
      if (readyMessage) {
        setWebappReady(true);
        onWorkspaceReady();
        return;
      }
      const collaborationSource = [...collaborationFrames.current.values()].find(frame => frame.contentWindow === event.source)?.contentWindow;
      const artifactRequest = readWebArtifactOpenRequest(
        event,
        window.location.origin,
        collaborationSource ?? webappFrameRef.current?.contentWindow ?? null,
      );
      if (artifactRequest) {
        const showArtifact = (path: string) => {
          setDrawerTab("files");
          setDrawerOpen(!isWebMediaUrl(path));
          setPreviewPath(path);
          if (!isWebMediaUrl(path)) setFileTreeRevealRequest({ ...artifactRequest, path });
        };
        if (artifactRequest.path.startsWith("~/")) {
          void rpc<{ home: string }>("hello").then(({ home }) => {
            const path = resolveWebArtifactPath(artifactRequest.path, null, home);
            if (path) showArtifact(path);
          }).catch(() => {});
        } else showArtifact(artifactRequest.path);
        return;
      }
      const browserSource = event.source === remoteSource && remoteSource
        ? remoteSource : webappFrameRef.current?.contentWindow ?? null;
      const browserRequest = readWebBrowserRequest(event, window.location.origin, browserSource);
      if (browserRequest) {
        void rpc(browserRequest.method, {
          ...browserRequest.payload,
          ...(browserRequest.method === "browser:watch" ? { frameAck: true } : {}),
        }).then(
          (result) => {
            browserSource?.postMessage({
              type: WEBAPP_BROWSER_RESPONSE_TYPE,
              id: browserRequest.id,
              ok: true,
              result,
            }, window.location.origin);
          },
          (error: Error & { code?: string }) => {
            browserSource?.postMessage({
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
      void forwardWebProjectRequest(
        event,
        window.location.origin,
        [webappFrameRef.current?.contentWindow ?? null, dashboardSource,
          ...[...collaborationFrames.current.values()].map(frame => frame.contentWindow)],
        rpc,
      );
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onWorkspaceReady, rpc, postSkinToWebapp, themeId]);
  useEffect(() => {
    const forward = (event: Record<string, unknown>) => {
      for (const ref of [webappFrameRef, remoteDesktopFrameRef]) ref.current?.contentWindow?.postMessage({
        type: WEBAPP_BROWSER_EVENT_TYPE,
        event,
      }, window.location.origin);
    };
    const eventTypes = ["browser:session", "browser:frame", "browser:state", "browser:closed", "browser:webrtc"];
    const unsubscribers = eventTypes.map((type) => onEvent(type, forward));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [onEvent]);
  useEffect(() => {
    if (!webappReady) return;
    webappFrameRef.current?.contentWindow?.postMessage({
      type: WEBAPP_BROWSER_EVENT_TYPE,
      event: { type: "browser:connection", connected: state.connected, epoch },
    }, window.location.origin);
  }, [state.connected, epoch, webappReady]);
  useEffect(() => {
    if (!remoteDesktopReadyEpoch) return;
    remoteDesktopFrameRef.current?.contentWindow?.postMessage({
      type: REMOTE_DESKTOP_VISIBILITY_TYPE,
      visible: activeTerminalId === REMOTE_DESKTOP_TAB.id,
    }, window.location.origin);
  }, [activeTerminalId, remoteDesktopReadyEpoch]);
  useEffect(() => {
    if (!remoteDesktopReadyEpoch) return;
    remoteDesktopFrameRef.current?.contentWindow?.postMessage({
      type: WEBAPP_BROWSER_EVENT_TYPE,
      event: { type: "browser:connection", connected: state.connected, epoch },
    }, window.location.origin);
  }, [state.connected, epoch, remoteDesktopReadyEpoch]);
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
  const persistDeviceState=useCallback((payload:Record<string,unknown>)=>{if(!auth.csrfToken)return;fetch("/api/web-console/device-state",{method:"PUT",credentials:"same-origin",keepalive:true,headers:{"content-type":"application/json","x-csrf-token":auth.csrfToken},body:JSON.stringify(payload)}).catch(()=>{});},[auth.csrfToken]);
  useEffect(()=>{if(!auth.csrfToken||!workspaceRestored||!deviceStateLoaded)return;const timer=setTimeout(()=>persistDeviceState({activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollowMode:fileTreeFollow,selectedFile:previewPath,terminalScroll}),500);return()=>clearTimeout(timer);},[activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollow,previewPath,terminalScroll,auth.csrfToken,persistDeviceState,workspaceRestored,deviceStateLoaded]);
  useEffect(()=>{if(!auth.csrfToken||!workspaceRestored||!deviceStateLoaded)return;const flush=()=>persistDeviceState({activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollowMode:fileTreeFollow,selectedFile:previewPath,terminalScroll});window.addEventListener("pagehide",flush);return()=>window.removeEventListener("pagehide",flush);},[activeTerminalId,drawerOpen,drawerTab,fileTreeRoot,fileTreeFollow,previewPath,terminalScroll,auth.csrfToken,persistDeviceState,workspaceRestored,deviceStateLoaded]);

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
    if (activeTab?.kind && activeTab.kind !== "webapp") return;
    if (activeTab && !activeTab.kind) {
      const fill = fillByTerminal.current.get(activeTab.id);
      if (fill) fill(command, true);
      else pendingCommandByTerminal.current.set(activeTab.id, command);
      setDrawerOpen(false);
      return;
    }

    const reusable = tabs.length >= 8 ? tabs.find((tab) => !tab.kind) : null;
    const terminalId = reusable?.id ?? `t-web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (reusable) pendingCommandByTerminal.current.set(terminalId, command);
    else setTabs((current) => [...current, { id: terminalId, title: `Terminal ${current.length + 1}`, initialCommand: command }]);
    setActiveTerminalId(terminalId);
    setDrawerOpen(false);
  }, [activeTerminalId, tabs]);

  useEffect(() => {
    if (!state.connected || !deviceStateLoaded || tabsHydrated.current) return;
    tabsHydrated.current = true;
    let cancelled = false;
    let restored = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    rpc<{ tabs: Array<{ id: string; title: string; status: string }> }>("term:list").then((result) => {
      if (cancelled) return;
      let saved = null;
      try { saved = parseWorkspaceSnapshot(localStorage.getItem(workspaceStorageKey)); } catch {}
      const restorable = restoreWorkspaceTabs(saved, result.tabs, tabsRef.current);
      setTabs(restorable);
      setActiveTerminalId((value) => {
        const selectedUtility = tabsRef.current.find((tab) => tab.id === value && (tab.kind && tab.kind !== "webapp"));
        if (selectedUtility) return selectedUtility.id;
        const preferred = saved?.activeTerminalId || restoredActiveId.current || value || WEBAPP_TAB.id;
        if (preferred === WEBAPP_TAB.id) return WEBAPP_TAB.id;
        return restorable.some((tab) => tab.id === preferred) ? preferred : WEBAPP_TAB.id;
      });
      restored = true;
      setWorkspaceRestored(true);
    }).catch(() => {
      if (cancelled) return;
      tabsHydrated.current = false;
      retryTimer = setTimeout(() => setWorkspaceRestoreAttempt(value => value + 1), 2000);
    });
    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      if (!restored) tabsHydrated.current = false;
    };
  }, [state.connected, deviceStateLoaded, rpc, workspaceStorageKey, workspaceRestoreAttempt]);

  useLayoutEffect(() => {
    if (!workspaceRestored) return;
    try {
      const snapshot = parseWorkspaceSnapshot(JSON.stringify({ tabs, activeTerminalId }));
      localStorage.setItem(workspaceStorageKey, JSON.stringify(snapshot));
    } catch {}
  }, [tabs, activeTerminalId, workspaceRestored, workspaceStorageKey]);

  const closeTerminal = (id: string) => {
    if (id === WEBAPP_TAB.id) return;
    const closingKind = tabs.find((tab) => tab.id === id)?.kind;
    if (closingKind === "remote-desktop") {
      setRemoteDesktopReadyEpoch(0);
      setRemoteDesktopContentReady(false);
      void rpc("browser:unwatch").catch(() => {});
    }
    // Utility tabs have no terminal process behind them.
    if (!closingKind && !window.confirm("关闭页签会终止该终端进程，确认关闭？")) return;
    // Drop the tab immediately — the kill RPC rides in the background because
    // its reply queues behind any terminal output on the same socket, and
    // waiting on it made close feel stuck (or hung until timeout).
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== id);
      if (activeTerminalId === id) setActiveTerminalId(next[0]?.id ?? null);
      return next;
    });
    if (!closingKind) void rpc("term:kill", { id }).catch(() => {});
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

  // Flow Studio shares the console workspace but never creates a terminal process.
  const openFlowStudioTab = useCallback(() => {
    setTabs((current) => {
      const existing = current.find((tab) => tab.kind === "flowstudio");
      if (existing) {
        setActiveTerminalId(existing.id);
        return current;
      }
      setActiveTerminalId(FLOW_STUDIO_TAB.id);
      return [...current, { ...FLOW_STUDIO_TAB }];
    });
  }, []);

  const openRemoteDesktopTab = useCallback(() => {
    setTabs(withRemoteDesktopTab);
    setActiveTerminalId(REMOTE_DESKTOP_TAB.id);
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
    <div className={`web-root ${remoteDesktopFullscreen && activeTerminalId === REMOTE_DESKTOP_TAB.id && !selectedPage ? "is-remote-fullscreen" : ""}`} style={rootStyle}>
      <style dangerouslySetInnerHTML={{ __html: CONSOLE_CSS }} />

      <div className="terminal-tabs">
        {selectedPage && <div className="computer-page-heading"><button type="button" className="file-drawer-toggle" aria-label="返回电脑会话" title="返回电脑会话" onClick={() => setSelectedPage(null)}><ArrowLeft size={18} /></button><span>{selectedPage.name}</span><a className="file-drawer-toggle" href={selectedPage.url} target="_blank" rel="noopener noreferrer" aria-label="在新页面打开当前页面" title="打开原页面"><ExternalLink size={16} /></a></div>}
        <div className="terminal-tab-list" ref={tabBarRef} hidden={Boolean(selectedPage)}>
          {tabs.map((tab) => (
            <div key={tab.id} data-terminal-id={tab.id} draggable className={`terminal-tab ${tab.id === activeTerminalId ? "active" : ""}`} onDragStart={()=>{draggedTab.current=tab.id;}} onDragOver={(event)=>event.preventDefault()} onDrop={(event)=>{event.preventDefault();const source=draggedTab.current;draggedTab.current=null;if(!source||source===tab.id)return;setTabs((current)=>{const from=current.findIndex(item=>item.id===source),to=current.findIndex(item=>item.id===tab.id);if(from<0||to<0)return current;const next=[...current];const [moved]=next.splice(from,1);next.splice(to,0,moved);rpc("term:reorder",{ids:next.filter(item=>!item.kind).map(item=>item.id)}).catch(()=>{});return next;});}} onClick={() => setActiveTerminalId(tab.id)} onDoubleClick={() => {
              if (tab.kind) return;
              const title = window.prompt("页签名称", tab.title)?.trim();
              if (!title) return;
              rpc("term:rename", { id: tab.id, title }).then(() => setTabs((items) => items.map((item) => item.id === tab.id ? { ...item, title } : item))).catch(() => {});
            }}>
              <span>{tab.title}</span>{tab.kind !== "webapp" && <button tabIndex={-1} onClick={(event) => { event.stopPropagation(); closeTerminal(tab.id); }}>×</button>}
          </div>
        ))}
        </div>
        <button className="terminal-add" aria-label="新建终端页签" hidden={Boolean(selectedPage)} disabled={tabs.length >= 8} onClick={addTerminal}>＋</button>
        <div className="terminal-connection">
          <ResponsiveToolbar
            glass={themeId === "glass"}
            avatar={<ComputerSwitcher username={auth.user?.username ?? "?"} connected={state.connected} accent={activeTheme.keybar.accent} accentText={activeTheme.keybar.accentText} selectedPageId={selectedPage?.id} onSelectPage={selectComputerPage} onUpdatePage={updateComputerPage} configuration={computerConfiguration} csrfToken={auth.csrfToken} />}
            items={[
              { id: "refresh", content: <button type="button" className="file-drawer-toggle" aria-label="刷新页面" title="刷新页面" onClick={() => selectedPage ? setPageReloadKey(key => key + 1) : window.location.reload()}><RefreshCw size={17} aria-hidden="true" /></button> },
              { id: "collaboration", content: <button type="button" className="file-drawer-toggle" aria-label="打开群聊看板" title="群聊看板" onClick={() => {
                setSelectedPage(null);
                setTabs(withCollaborationDashboard);
                setActiveTerminalId(COLLABORATION_DASHBOARD_TAB.id);
              }}><UsersRound size={17} aria-hidden="true" /></button> },
              { id: "install", content: <PwaInstallButton /> },
              { id: "remote", content: <button type="button" className="file-drawer-toggle" aria-label="打开远程桌面" title="远程桌面 · 浏览器直播" onClick={() => { setSelectedPage(null); openRemoteDesktopTab(); }}><MonitorUp size={17} aria-hidden="true" /></button> },
              { id: "ai-hub", content: <button type="button" className="file-drawer-toggle" aria-label="打开 AI Hub" title="AI Hub · 多模型对比" onClick={() => { setSelectedPage(null); openAiHubTab(); }}><LayoutGrid size={17} aria-hidden="true" /></button> },
              { id: "flow", content: <button type="button" className="file-drawer-toggle" aria-label="打开数字人" title="数字人 · Flow Studio" onClick={() => { setSelectedPage(null); openFlowStudioTab(); }}><Bot size={17} aria-hidden="true" /></button> },
              { id: "theme", content: <ThemePicker themeId={themeId} onThemeChange={setThemeId} /> },
              { id: "files", content: <button type="button" className="file-drawer-toggle" aria-label={drawerOpen ? "关闭我的文件" : "打开我的文件"} title="我的文件" aria-expanded={drawerOpen} onClick={() => { setSelectedPage(null); setDrawerOpen((open) => !open); }}><PanelRight size={17} aria-hidden="true" /></button> },
            ].filter(item => computerConfiguration.settings.visibleTools.some(id => id === item.id)).sort((left, right) => computerConfiguration.settings.visibleTools.findIndex(id => id === left.id) - computerConfiguration.settings.visibleTools.findIndex(id => id === right.id))}
          />
        </div>
      </div>

      {/* workspace: terminal first in DOM = fullscreen by default */}
      <main
        className={`workspace ${drawerOpen ? "show-tree" : ""} ${previewPath ? "has-preview" : ""}`}
        hidden={Boolean(selectedPage)}
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
                <iframe ref={webappFrameRef} className="webapp-frame" src={consoleFrameUrl("/app/")} title={tab.title} onLoad={() => postSkinToWebapp(themeId)} />
              ) : tab.kind === "collaboration-dashboard" ? (
                <CollaborationPane title="群聊看板" onFrame={frame => { collaborationDashboardFrame.current = frame; }} onLoad={() => postSkinToWebapp(themeId)} />
              ) : tab.kind === "collaboration" ? (
                <CollaborationPane key={`${tab.id}-${collaborationFrameRevisions[tab.groupId || ""] || 0}`} groupId={tab.groupId || ""} title={tab.title} onFrame={frame => { if (frame) collaborationFrames.current.set(tab.id, frame); else collaborationFrames.current.delete(tab.id); }} onLoad={() => postSkinToWebapp(themeId)} />
              ) : tab.kind === "remote-desktop" ? (
                <div style={{ height: "100%", background: "var(--ui-term-col-bg, #101014)" }} aria-busy={!remoteDesktopContentReady}>
                  <iframe ref={remoteDesktopFrameRef} className="webapp-frame" style={{ visibility: remoteDesktopContentReady ? "visible" : "hidden" }} src={consoleFrameUrl("/app/?view=remote-desktop")} title="远程桌面" onLoad={() => postSkinToWebapp(themeId)} />
                  {!remoteDesktopContentReady && <FlowStudioLoading label="REMOTE DESKTOP" title="正在打开远程桌面" caption="正在准备桌面与连接" icon={<MonitorUp size={36} strokeWidth={1.5} />} />}
                </div>
              ) : tab.kind === "aihub" ? (
                <AiHubPane visible={tab.id === activeTerminalId} rpc={rpc} />
              ) : tab.kind === "flowstudio" ? (
                <FlowStudioPane visible={tab.id === activeTerminalId} />
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
            gateway={fileWorkspaceGateway}
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
            <FilePreview path={previewPath} gateway={fileWorkspaceGateway} onClose={() => setPreviewPath(null)} />
          </section>
        )}
      </main>
      {selectedPage && <ComputerPagePane key={selectedPage.id} page={selectedPage} reloadKey={pageReloadKey} />}

    </div>
  );
}


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
