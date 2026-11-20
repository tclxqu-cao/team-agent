import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Monitor } from "lucide-react";
import type { DesktopActivity } from "../../../core/src/domain/live-view/desktop-control.js";
import { REMOTE_DESKTOP_FULLSCREEN_TYPE } from "../../../core/src/domain/web-console/RemoteDesktopTabBridge.js";
import "./session-desktop-projection.css";

const BrowserLivePanel = lazy(() => import("./BrowserLivePanel"));

export function sessionDesktopStatus(activity: DesktopActivity | null, sessionId: string | null, observedToolRunId?: string) {
  if (!activity || !sessionId) return { runId: null, status: "共享桌面" };
  const owner = activity.owner;
  if (owner?.kind === "agent" && owner.run.sessionId === sessionId) {
    return { runId: owner.run.runId, status: "正在操作电脑" };
  }
  const operator = owner?.kind === "agent"
    ? `${owner.run.title || "另一个会话"} 正在操作`
    : owner?.kind === "viewer" ? "有人正在远程操作" : null;
  const position = activity.queue.findIndex((entry) => entry.sessionId === sessionId);
  if (position < 0) {
    return {
      runId: observedToolRunId ?? null,
      status: operator ?? (observedToolRunId ? "本会话调用了电脑工具" : "共享桌面"),
    };
  }
  const waiting = `本会话排队第 ${position + 1} 位`;
  return { runId: activity.queue[position].runId, status: operator ? `${operator} · ${waiting}` : waiting };
}

export function useSessionDesktopProjection(sessionId: string | null, observedToolRunId?: string) {
  const api = sessionId && typeof window !== "undefined" ? window.browserLiveApi : undefined;
  const [activity, setActivity] = useState<DesktopActivity | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [viewer, setViewer] = useState<{ sessionId: string; mode: "preview" | "fullscreen" } | null>(null);
  const [foldedRuns, setFoldedRuns] = useState<string[]>([]);

  useEffect(() => {
    if (!api) return;
    let mounted = true;
    let revision = 0;
    const refresh = async () => {
      const reading = ++revision;
      try {
        const { desktopActivity } = await api.request<{ desktopActivity?: DesktopActivity }>("browser:list");
        if (!mounted || revision !== reading) return;
        setActivity(desktopActivity ?? null);
        setDisconnecting(false);
      } catch {
        if (mounted && revision === reading) setDisconnecting(true);
      }
    };
    const unsubscribe = api.onEvent((event) => {
      if (event.type === "browser:desktop-activity") {
        revision += 1;
        setActivity(event.desktopActivity as DesktopActivity);
        setDisconnecting(false);
      } else if (event.type === "browser:connection") {
        if (event.connected === true) void refresh();
        else { revision += 1; setDisconnecting(true); }
      }
    });
    void refresh();
    return () => { mounted = false; unsubscribe(); };
  }, [api]);

  useEffect(() => { setViewer(null); }, [sessionId]);
  const { runId, status } = sessionDesktopStatus(activity, sessionId, observedToolRunId);
  const available = Boolean(api && activity);
  const manual = viewer !== null && viewer.sessionId === sessionId;
  const expanded = manual && viewer.mode === "fullscreen";
  const showPreview = manual || Boolean(runId && !foldedRuns.includes(runId));
  const open = useCallback(() => {
    if (sessionId) setViewer({ sessionId, mode: "preview" });
  }, [sessionId]);
  const expand = useCallback(() => {
    if (sessionId) setViewer({ sessionId, mode: "fullscreen" });
  }, [sessionId]);
  const toggleFold = useCallback(() => {
    setViewer(null);
    if (runId) setFoldedRuns((runs) => {
      const otherRuns = runs.filter((item) => item !== runId);
      return showPreview ? [...otherRuns.slice(-63), runId] : otherRuns;
    });
  }, [runId, showPreview]);

  return {
    available,
    runId,
    status: disconnecting ? "正在重新连接桌面" : status,
    expanded,
    showPreview,
    open,
    expand,
    toggleFold,
  };
}

export default function SessionDesktopProjection({ desktop, scrollRef }: {
  desktop: ReturnType<typeof useSessionDesktopProjection>;
  scrollRef: RefObject<HTMLDivElement>;
}) {
  const card = useRef<HTMLElement>(null);
  const [inView, setInView] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const showPreview = desktop.showPreview;

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (!showPreview || !card.current) { setInView(false); return; }
    if (typeof IntersectionObserver === "undefined") { setInView(true); return; }
    const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting));
    observer.observe(card.current);
    return () => observer.disconnect();
  }, [showPreview]);

  useLayoutEffect(() => {
    if (!desktop.expanded || window.parent === window) return;
    const scroll = scrollRef.current;
    const scrollTop = scroll?.scrollTop ?? 0;
    window.parent.postMessage({ type: REMOTE_DESKTOP_FULLSCREEN_TYPE, fullscreen: true }, location.origin);
    return () => {
      window.parent.postMessage({ type: REMOTE_DESKTOP_FULLSCREEN_TYPE, fullscreen: false }, location.origin);
      if (scroll) requestAnimationFrame(() => requestAnimationFrame(() => {
        if (scroll.isConnected) scroll.scrollTop = scrollTop;
      }));
    };
  }, [desktop.expanded, scrollRef]);

  if (!desktop.available || (!desktop.runId && !showPreview)) return null;

  return <section ref={card} className={`session-desktop-card${showPreview ? "" : " is-folded"}`} aria-label="会话桌面">
    <div className="session-desktop-status">
      <Monitor size={15} aria-hidden="true" />
      <span role="status" title={desktop.status}>{desktop.status}</span>
      <button type="button" className="session-desktop-fold" aria-expanded={showPreview} onClick={desktop.toggleFold}>
        {showPreview ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}
        {showPreview ? "收起" : "展开预览"}
      </button>
    </div>
    {showPreview && <div className="session-desktop-screen">
      <Suspense fallback={<span className="session-desktop-preview-empty">正在连接桌面</span>}>
        <BrowserLivePanel
          open
          active={pageVisible && (desktop.expanded || inView)}
          sessionDesktop={{ expanded: desktop.expanded, status: desktop.status, onExpand: desktop.expand }}
          onClose={desktop.open}
        />
      </Suspense>
    </div>}
  </section>;
}
