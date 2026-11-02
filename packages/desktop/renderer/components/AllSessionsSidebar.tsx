import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { CatalogSession, SessionCatalogPage } from "../../../core/src/domain/supervision/types";
import { loadAllSessions, orderAllSessions } from "../lib/all-sessions";
import { getSidebarSessionVisualState, SIDEBAR_SESSION_STATUS_LABELS } from "../lib/sidebar-session-status";
import { collaborationRequest } from "./collaboration/client";
import { AGENT_LABELS } from "../lib/agent-catalog";
import SidebarSessionRow, { type SidebarDeleteAnchor } from "./SidebarSessionRow";
import SidebarRefreshButton from "./SidebarRefreshButton";
import "../styles/all-sessions.css";

interface Props {
  selectedSessionId: string | null;
  runningSessionId: string | null;
  needsInput: string[];
  pinnedIds: string[];
  revision: number;
  onSelect(session: CatalogSession): void;
  onPin(sessionId: string): void;
  onDelete(session: CatalogSession, anchor: SidebarDeleteAnchor): void;
}

export default function AllSessionsSidebar(props: Props) {
  const [sessions, setSessions] = useState<CatalogSession[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const hasSnapshot = useRef(false);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError(null);
    const showProgress = !hasSnapshot.current;
    let snapshot: { rows: CatalogSession[]; total: number } | undefined;
    try {
      await loadAllSessions(
        cursor => collaborationRequest<SessionCatalogPage>({ action: "sessionCatalog", limit: 100, cursor }),
        controller.signal,
        (rows, count) => {
          snapshot = { rows, total: count };
          if (showProgress) { setSessions(rows); setTotal(count); hasSnapshot.current = true; }
        },
      );
      // Keep the current scroll height while refreshing later history pages.
      if (snapshot) { setSessions(snapshot.rows); setTotal(snapshot.total); hasSnapshot.current = true; }
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "会话加载失败");
    } finally {
      if (!controller.signal.aborted) { request.current = null; setLoading(false); }
    }
  }, []);

  useEffect(() => {
    void refresh();
    const refreshIfIdle = () => {
      if (document.visibilityState === "visible" && !request.current) void refresh();
    };
    const timer = window.setInterval(refreshIfIdle, 15_000);
    window.addEventListener("focus", refreshIfIdle);
    document.addEventListener("visibilitychange", refreshIfIdle);
    return () => {
      request.current?.abort();
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfIdle);
      document.removeEventListener("visibilitychange", refreshIfIdle);
    };
  }, [refresh, props.revision, props.runningSessionId]);

  const activeIds = [...props.needsInput, ...(props.runningSessionId ? [props.runningSessionId] : [])];
  const ordered = orderAllSessions(sessions, props.pinnedIds, activeIds);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = ordered.filter(session => !normalized
    || `${session.title} ${session.cwd} ${AGENT_LABELS[session.agentType]}`.toLocaleLowerCase().includes(normalized));
  const pinned = useMemo(() => new Set(props.pinnedIds), [props.pinnedIds]);

  return <>
    <label className="sidebar-search-field all-sessions-search">
      <Search size={15} aria-hidden="true" />
      <input aria-label="搜索所有 Agent 的会话" placeholder="搜索会话或目录" value={query}
        onChange={event => { setQuery(event.target.value); setLimit(50); }} />
    </label>
    <div className="sidebar-project-toolbar">
      <div className="sidebar-project-heading"><span className="sidebar-project-title">所有会话</span><span className="sidebar-project-count">{normalized ? visible.length : total}</span></div>
      <div className="sidebar-project-actions"><span className="all-sessions-sort-label">进行中优先</span>
        <SidebarRefreshButton loading={loading} error={error} subject="所有会话" onRefresh={() => void refresh()} />
      </div>
    </div>
    <div className="app-sidebar-scroll all-sessions-list" aria-label="所有 Agent 会话" aria-busy={loading}
      onScroll={event => {
        const node = event.currentTarget;
        if (node.scrollHeight - node.scrollTop - node.clientHeight < 120) setLimit(current => Math.min(current + 50, visible.length));
      }}>
      {error && <div role="alert" className="sidebar-load-error"><span>{error}</span><button onClick={() => void refresh()}>重试</button></div>}
      {loading && !sessions.length && <p className="all-sessions-empty" role="status">正在加载所有会话…</p>}
      {!loading && !error && !visible.length && <p className="all-sessions-empty">{normalized ? "没有匹配的会话" : "暂无会话，开始一个新任务吧"}</p>}
      {visible.slice(0, limit).map(session => {
        const activity = props.needsInput.includes(session.id) ? "needs-input"
          : props.runningSessionId === session.id ? "running" : session.status === "failed" ? "error" : session.status;
        const visualState = getSidebarSessionVisualState(activity);
        return <SidebarSessionRow key={session.id} session={{
          id: session.id, title: session.title, agentType: session.agentType, workspacePath: session.cwd,
          visualState, statusLabel: SIDEBAR_SESSION_STATUS_LABELS[visualState],
          active: props.selectedSessionId === session.id, pinned: pinned.has(session.id),
          occupiedExternally: session.agentType !== "codex" && session.occupancy === "owned-externally",
          canDelete: activity !== "running" && activity !== "needs-input",
        }} onSelect={() => props.onSelect(session)} onPin={() => props.onPin(session.id)}
          onDelete={anchor => props.onDelete(session, anchor)} />;
      })}
      {visible.length > limit && <button className="all-sessions-more" onClick={() => setLimit(current => current + 50)}>加载更早的会话</button>}
    </div>
  </>;
}
