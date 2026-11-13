import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import type { CatalogSession, SessionCatalogPage } from "../../../core/src/domain/supervision/types";
import { readSessionCatalogPage, mergeCatalogSessions, orderAllSessions } from "../lib/all-sessions";
import { readAllSessionsCache, writeAllSessionsCache } from "../lib/all-sessions-cache";
import { usePageActive, isPageActive } from "../lib/page-activity";
import { getSidebarSessionVisualState, SIDEBAR_SESSION_STATUS_LABELS } from "../lib/sidebar-session-status";
import { collaborationRequest } from "./collaboration/client";
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
  const active = usePageActive();
  const [initialCache] = useState(() => readAllSessionsCache());
  const [sessions, setSessions] = useState<CatalogSession[]>(initialCache?.data ?? []);
  const [total, setTotal] = useState(initialCache?.total ?? 0);
  const [showingCache, setShowingCache] = useState(initialCache !== null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const requestQuery = useRef("");
  const refreshedRevision = useRef(`${props.revision}:${props.runningSessionId}`);
  const snapshot = useRef({ query: "", rows: initialCache?.data ?? [], cursor: null as string | null });
  const firstPageRequest = useRef<{ query: string; promise: Promise<SessionCatalogPage> } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (reset: boolean) => {
    if (!isPageActive() || (!reset && (request.current || !snapshot.current.cursor))) return;
    if (request.current && !request.current.signal.aborted && requestQuery.current === search) return;
    if (reset) request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    requestQuery.current = search;
    const previous = snapshot.current;
    setLoading(true); setError(null);
    if (reset && previous.query !== search) {
      const cached = search ? null : readAllSessionsCache();
      snapshot.current = { query: search, rows: cached?.data ?? [], cursor: null };
      setSessions(cached?.data ?? []); setTotal(cached?.total ?? 0); setNextCursor(null);
      setShowingCache(cached !== null);
    }
    try {
      let page: SessionCatalogPage;
      if (reset) {
        const pending = firstPageRequest.current;
        if (pending?.query === search) {
          page = await pending.promise;
        } else {
          const promise = collaborationRequest<SessionCatalogPage>({ action: "sessionCatalog", query: search, limit: 20 });
          const entry = { query: search, promise };
          firstPageRequest.current = entry;
          try {
            page = await promise;
          } finally {
            if (firstPageRequest.current === entry) firstPageRequest.current = null;
          }
        }
        if (controller.signal.aborted) return;
      } else {
        page = await readSessionCatalogPage(
          cursor => collaborationRequest<SessionCatalogPage>({ action: "sessionCatalog", query: search, limit: 20, cursor }),
          controller.signal, previous.cursor ?? undefined,
        );
      }
      const rows = reset ? page.data : mergeCatalogSessions(previous.rows, page.data);
      snapshot.current = { query: search, rows, cursor: page.nextCursor };
      setSessions(rows); setTotal(page.total); setNextCursor(page.nextCursor);
      setShowingCache(false);
      if (reset && !search) writeAllSessionsCache(page);
      if (reset && previous.query !== search && scroll.current) scroll.current.scrollTop = 0;
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : "会话加载失败");
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }, [search]);

  useEffect(() => {
    if (!active) return;
    const revision = `${props.revision}:${props.runningSessionId}`;
    const invalidated = refreshedRevision.current !== revision;
    refreshedRevision.current = revision;
    // Refresh only the first page. An expanded history keeps its snapshot and scroll position.
    if (invalidated || snapshot.current.query !== search || snapshot.current.rows.length <= 20) void load(true);
    const refreshIfIdle = () => {
      if (isPageActive() && !request.current && snapshot.current.rows.length <= 20) void load(true);
    };
    const timer = window.setInterval(refreshIfIdle, 15_000);
    window.addEventListener("focus", refreshIfIdle);
    return () => {
      request.current?.abort();
      firstPageRequest.current = null;
      window.clearInterval(timer);
      window.removeEventListener("focus", refreshIfIdle);
    };
  }, [active, load, search, props.revision, props.runningSessionId]);

  const activeIds = [...props.needsInput, ...(props.runningSessionId ? [props.runningSessionId] : [])];
  const ordered = orderAllSessions(sessions, props.pinnedIds, activeIds);
  const normalized = query.trim().toLocaleLowerCase();
  const visible = ordered;
  const pinned = useMemo(() => new Set(props.pinnedIds), [props.pinnedIds]);

  return <>
    <label className="sidebar-search-field all-sessions-search">
      <Search size={15} aria-hidden="true" />
      <input aria-label="搜索所有 Agent 的会话" placeholder="搜索会话或目录" value={query}
        onChange={event => { setQuery(event.target.value); }} />
    </label>
    <div className="sidebar-project-toolbar">
      <div className="sidebar-project-heading"><span className="sidebar-project-title">所有会话</span><span className="sidebar-project-count">{total}</span></div>
      <div className="sidebar-project-actions"><span className="all-sessions-sort-label">进行中优先</span>
        <SidebarRefreshButton loading={loading} error={error} subject="所有会话" onRefresh={() => void load(true)} />
      </div>
    </div>
    <div ref={scroll} className="app-sidebar-scroll all-sessions-list" aria-label="所有 Agent 会话" aria-busy={loading && !showingCache && !sessions.length}
      onScroll={event => {
        const node = event.currentTarget;
        if (node.scrollTop > 0 && node.scrollHeight - node.scrollTop - node.clientHeight < 120) void load(false);
      }}>
      {error && <div role="alert" className="sidebar-load-error"><span>{error}</span><button onClick={() => void load(true)}>重试</button></div>}
      {showingCache && <p className="sidebar-cache-state" role="status">{loading ? "显示缓存，正在后台更新…" : "当前显示缓存"}</p>}
      {loading && !sessions.length && !showingCache && <p className="all-sessions-empty" role="status">正在加载所有会话…</p>}
      {(!loading || showingCache) && !error && !visible.length && <p className="all-sessions-empty">{normalized ? "没有匹配的会话" : "暂无会话，开始一个新任务吧"}</p>}
      {visible.map(session => {
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
      {nextCursor && <button className="all-sessions-more" disabled={loading} onClick={() => void load(false)}>{loading ? "正在加载…" : "加载更早的会话"}</button>}
    </div>
  </>;
}
