import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Search, X } from "lucide-react";
import type { CatalogSession, SessionCatalogPage } from "../../../../core/src/domain/supervision/types";
import { collaborationRequest, AGENT_NAMES } from "../collaboration/client";
import AgentBrandIcon from "../AgentBrandIcon";
import { mergeCatalogSessions } from "../../lib/all-sessions";
import { readAllSessionsCache, writeAllSessionsCache } from "../../lib/all-sessions-cache";

interface Props {
  currentId?: string;
  openIds: ReadonlySet<string>;
  knownSessions?: CatalogSession[];
  onChoose(session: CatalogSession): void;
  onClose(): void;
}

function matchingSessions(sessions: CatalogSession[], query: string): CatalogSession[] {
  const search = query.trim().toLocaleLowerCase();
  return sessions.filter(session => `${session.title} ${session.cwd} ${session.agentType}`.toLocaleLowerCase().includes(search));
}

export default function TaskSessionPicker({ currentId, openIds, knownSessions = [], onChoose, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState(() => mergeCatalogSessions(readAllSessionsCache()?.data ?? [], knownSessions));
  const available = useRef(sessions);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const input = useRef<HTMLInputElement>(null);
  const refreshTimer = useRef<number>();
  const close = useRef(onClose);
  close.current = onClose;
  const load = async (search: string, after?: string) => {
    window.clearTimeout(refreshTimer.current);
    const token = ++generation.current;
    setLoading(true); setError(null);
    try {
      const page = await collaborationRequest<SessionCatalogPage>({ action: "sessionCatalog", query: search, cursor: after, limit: 30, backgroundRefresh: true });
      if (!alive.current || token !== generation.current) return;
      if (after && page.nextCursor === after) throw new Error("会话分页已失效，请重新搜索");
      // Partial discovery cannot invalidate cached tasks. Only a completed
      // first page replaces the visible result, including a genuinely empty one.
      setSessions(previous => after || page.refreshing ? mergeCatalogSessions(previous, page.data) : page.data);
      available.current = !search && !after && !page.refreshing
        ? page.data : mergeCatalogSessions(available.current, page.data);
      if (!search && !after && !page.refreshing) writeAllSessionsCache(page);
      setCursor(page.nextCursor);
      setRefreshing(page.refreshing === true);
      if (page.refreshing) refreshTimer.current = window.setTimeout(() => { void load(search); }, 2_000);
    } catch (failure) {
      if (alive.current && token === generation.current) {
        setRefreshing(false);
        const message = failure instanceof Error ? failure.message : "无法加载任务";
        setError(/timeout|timed out/i.test(message) ? "任务列表更新超时，请重试" : message);
      }
    } finally {
      if (alive.current && token === generation.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { alive.current = false; generation.current++; window.clearTimeout(refreshTimer.current); document.removeEventListener("keydown", keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    generation.current++;
    window.clearTimeout(refreshTimer.current);
    setSessions(matchingSessions(available.current, query)); setCursor(null); setLoading(true); setRefreshing(false); setError(null);
    const timer = window.setTimeout(() => { void load(query.trim()); }, query ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [query]);

  return createPortal(<div className="task-picker-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="task-picker" role="dialog" aria-modal="true" aria-label="选择分屏任务" onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><h2>选择任务</h2><button type="button" className="ui-icon-button" onClick={onClose} aria-label="关闭任务选择"><X size={18} /></button></header>
      <label className="task-picker-search"><Search size={16} aria-hidden="true" /><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务、目录或 Agent" aria-label="搜索分屏任务" /></label>
      {error && <div className="task-picker-error" role="alert">{error}<button type="button" onClick={() => void load(query.trim())}>重试</button></div>}
      <div className="task-picker-list" aria-busy={!sessions.length && (loading || refreshing)}>
        {sessions.map(session => <button type="button" key={session.id} className="task-picker-item" disabled={session.id === currentId} onClick={() => onChoose(session)}>
          <AgentBrandIcon agentType={session.agentType} size={20} /><span><strong>{session.title || "未命名任务"}</strong><small>{AGENT_NAMES[session.agentType]} · {session.cwd || "未指定目录"}</small></span>
          <em>{session.id === currentId ? "当前任务" : openIds.has(session.id) ? "已在分屏" : session.status === "running" ? "进行中" : ""}</em>
        </button>)}
        {!loading && !refreshing && !sessions.length && !error && <p className="task-picker-empty">没有找到任务，试试其他关键词</p>}
        {(loading || refreshing) && <p className="task-picker-empty" role="status"><LoaderCircle size={16} className="task-split-spinner" />{sessions.length ? "显示已有任务，正在后台更新…" : "正在加载任务…"}</p>}
        {cursor && !loading && !refreshing && <button className="task-picker-more" type="button" onClick={() => void load(query.trim(), cursor)}>加载更多任务</button>}
      </div>
    </section>
  </div>, document.body);
}
