import { ExternalLink, LoaderCircle, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { EmbeddedPageRect } from "../../global";
import { isWebShell } from "../../web/webLayout";
import TaskPaneBrowserPage from "./TaskPaneBrowserPage";
import "./task-pane-web-page.css";

interface Props {
  paneId: string;
  url: string;
  visible?: boolean;
  onFocus?: () => void;
}

type ViewState = "loading" | "ready" | "error";
const OVERLAYS = 'dialog[open], [aria-modal="true"], [data-task-page-overlay], .collab-desktop-overlay, .appearance-panel, .header-action-menu-panel, .composer-workspace-picker-menu--portal, .composer-agent-picker-menu, .composer-model-menu';

/** Websites use isolated native views, so frame headers do not block ordinary links. */
function NativeTaskPaneWebPage({ paneId, url, visible = true, onFocus }: Props) {
  const api = typeof window === "undefined" ? undefined : window.agentApi;
  const available = typeof api?.taskPageOpen === "function";
  const host = useRef<HTMLDivElement>(null);
  const focused = useRef(onFocus);
  focused.current = onFocus;
  const [state, setState] = useState<ViewState>("loading");
  const stateRef = useRef({ visible, state });
  stateRef.current = { visible, state };
  const lastBounds = useRef<string>("");
  const measureRef = useRef<() => void>(() => {});

  const open = useCallback(async () => {
    if (!available || !api) { setState("error"); return; }
    setState("loading");
    const result = await api.taskPageOpen(paneId, url).catch(() => ({ ok: false }));
    setState(result.ok ? "ready" : "error");
  }, [api, available, paneId, url]);

  useEffect(() => {
    if (!available || !api) { setState("error"); return; }
    const unsubscribe = api.onHubEvent(event => {
      if (event.siteId !== `task-pane-${paneId}`) return;
      if (event.type === "focused") focused.current?.();
      if (event.type === "loading") setState("loading");
      if (event.type === "loaded") setState("ready");
      if (event.type === "load-failed") setState("error");
    });
    return () => { unsubscribe(); void api.taskPageClose(paneId); };
  }, [api, available, paneId]);

  useEffect(() => { void open(); }, [open]);

  useEffect(() => {
    if (!available || !api || !host.current) return;
    const element = host.current;
    let frame = 0;
    const measure = () => {
      const bounds = element.getBoundingClientRect();
      const x = Math.max(0, bounds.left), y = Math.max(0, bounds.top);
      const width = Math.max(0, Math.min(window.innerWidth, bounds.right) - x);
      const height = Math.max(0, Math.min(window.innerHeight, bounds.bottom) - y);
      const covered = Array.from(document.querySelectorAll<HTMLElement>(OVERLAYS)).some(overlay => {
        if (!overlay.getClientRects().length || getComputedStyle(overlay).visibility === "hidden") return false;
        // A modal's backdrop blocks the whole workspace, including panes outside its dialog rectangle.
        if (overlay.matches('dialog[open], [aria-modal="true"]')) return true;
        const rect = overlay.getBoundingClientRect();
        return rect.left < x + width && rect.right > x && rect.top < y + height && rect.bottom > y;
      });
      const rect: EmbeddedPageRect | null = stateRef.current.visible && stateRef.current.state === "ready"
        && element.getClientRects().length > 0 && getComputedStyle(element).visibility === "visible"
        && !element.closest('[inert], [aria-hidden="true"]') && width > 0 && height > 0 && !covered
        ? { x, y, width, height } : null;
      const signature = JSON.stringify(rect);
      if (lastBounds.current === signature) return;
      lastBounds.current = signature;
      void api.taskPageSetBounds(paneId, rect);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measureRef.current = schedule;
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutations = new MutationObserver(schedule);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "open", "aria-hidden", "hidden", "inert"] });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();
    return () => {
      resize.disconnect(); mutations.disconnect(); cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      measureRef.current = () => {};
      lastBounds.current = "";
      void api.taskPageSetBounds(paneId, null);
    };
  }, [api, available, paneId]);

  useEffect(() => { measureRef.current(); }, [state, visible]);

  return <div className="task-pane-web-page" aria-label="网页" aria-busy={state === "loading"}>
    <div className="task-pane-web-address">
      <span title={url}>{url}</span>
      <button type="button" className="ui-icon-button" aria-label="刷新网页" title="刷新网页" onClick={() => {
        if (state === "error") { void open(); return; }
        void api?.taskPageReload(paneId);
      }}><RotateCw size={14} /></button>
      <button type="button" className="ui-icon-button" aria-label="在浏览器中打开" title="在浏览器中打开" onClick={() => { void api?.openExternal(url); }}><ExternalLink size={14} /></button>
    </div>
    <div ref={host} className="task-pane-web-content">
      {state !== "ready" && <div className="task-pane-web-status" role={state === "error" ? "alert" : "status"}>
        {state === "loading" ? <LoaderCircle className="task-split-spinner" size={20} /> : null}
        <span>{state === "loading" ? "正在打开网页…" : available ? "无法打开网页" : "请重启桌面端以启用内嵌网页"}</span>
        {state === "error" && available && <button type="button" onClick={() => { void open(); }}>重试</button>}
      </div>}
    </div>
  </div>;
}

export default function TaskPaneWebPage(props: Props) {
  return isWebShell() ? <TaskPaneBrowserPage {...props} /> : <NativeTaskPaneWebPage {...props} />;
}
