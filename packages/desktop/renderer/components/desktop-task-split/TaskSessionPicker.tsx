import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Folder, FolderTree, List, LoaderCircle, Search, X } from "lucide-react";
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

interface TaskFolderGroup {
  key: string;
  label: string;
  sessions: CatalogSession[];
}

interface TaskAgentGroup {
  key: CatalogSession["agentType"];
  label: string;
  folders: TaskFolderGroup[];
  sessionCount: number;
}

/** Preserve the catalog's relevance order while adding a stable Agent → folder hierarchy. */
export function groupTaskSessions(sessions: readonly CatalogSession[]): TaskAgentGroup[] {
  const agents = new Map<CatalogSession["agentType"], { folders: Map<string, TaskFolderGroup>; sessionCount: number }>();
  for (const session of sessions) {
    const agent = agents.get(session.agentType) ?? { folders: new Map<string, TaskFolderGroup>(), sessionCount: 0 };
    const folder = session.cwd?.trim() || "未指定文件夹";
    const folderKey = session.cwd?.trim() || "__unknown__";
    const existingFolder = agent.folders.get(folderKey);
    if (existingFolder) existingFolder.sessions.push(session);
    else agent.folders.set(folderKey, { key: `${session.agentType}:${folderKey}`, label: folder, sessions: [session] });
    agent.sessionCount += 1;
    agents.set(session.agentType, agent);
  }
  return [...agents].map(([key, group]) => ({
    key,
    label: AGENT_NAMES[key] ?? key,
    folders: [...group.folders.values()],
    sessionCount: group.sessionCount,
  }));
}

function TaskSessionItem({ session, currentId, openIds, onChoose }: {
  session: CatalogSession;
  currentId?: string;
  openIds: ReadonlySet<string>;
  onChoose(session: CatalogSession): void;
}) {
  return <button type="button" className="task-picker-item" disabled={session.id === currentId} onClick={() => onChoose(session)}>
    <AgentBrandIcon agentType={session.agentType} size={20} /><span><strong>{session.title || "未命名任务"}</strong><small>{AGENT_NAMES[session.agentType]} · {session.cwd || "未指定目录"}</small></span>
    <em>{session.id === currentId ? "当前任务" : openIds.has(session.id) ? "已在分屏" : session.status === "running" ? "进行中" : ""}</em>
  </button>;
}

export default function TaskSessionPicker({ currentId, openIds, knownSessions = [], onChoose, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grouped" | "flat">("grouped");
  const [collapsedAgents, setCollapsedAgents] = useState<ReadonlySet<string>>(new Set());
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
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
  const groups = useMemo(() => groupTaskSessions(sessions), [sessions]);
  const toggleCollapsed = (setter: Dispatch<SetStateAction<ReadonlySet<string>>>, key: string) => {
    setter(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return createPortal(<div className="task-picker-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="task-picker" role="dialog" aria-modal="true" aria-label="选择分屏任务" onKeyDown={event => {
      if (event.key !== "Tab") return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input'));
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <header><h2>选择任务</h2><div className="task-picker-header-actions">
        <div className="task-picker-view-toggle" role="group" aria-label="任务排列方式">
          <button type="button" className={`task-picker-view-button${viewMode === "grouped" ? " is-active" : ""}`} aria-pressed={viewMode === "grouped"} onClick={() => setViewMode("grouped")}><FolderTree size={14} aria-hidden="true" />分组</button>
          <button type="button" className={`task-picker-view-button${viewMode === "flat" ? " is-active" : ""}`} aria-pressed={viewMode === "flat"} onClick={() => setViewMode("flat")}><List size={14} aria-hidden="true" />平铺</button>
        </div>
        <button type="button" className="ui-icon-button" onClick={onClose} aria-label="关闭任务选择"><X size={18} /></button>
      </div></header>
      <label className="task-picker-search"><Search size={16} aria-hidden="true" /><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务、目录或 Agent" aria-label="搜索分屏任务" /></label>
      {error && <div className="task-picker-error" role="alert">{error}<button type="button" onClick={() => void load(query.trim())}>重试</button></div>}
      <div className="task-picker-list" aria-busy={!sessions.length && (loading || refreshing)}>
        {viewMode === "flat" ? sessions.map(session => <TaskSessionItem key={session.id} session={session} currentId={currentId} openIds={openIds} onChoose={onChoose} />)
          : groups.map(agent => {
            const agentCollapsed = collapsedAgents.has(agent.key);
            return <section className={`task-picker-agent-group${agentCollapsed ? " is-collapsed" : ""}`} key={agent.key} aria-label={`${agent.label}任务`}>
              <button type="button" className="task-picker-group-header" aria-expanded={!agentCollapsed} onClick={() => toggleCollapsed(setCollapsedAgents, agent.key)}>
                <ChevronDown size={15} className={`task-picker-chevron${agentCollapsed ? " is-collapsed" : ""}`} aria-hidden="true" />
                <AgentBrandIcon agentType={agent.key} size={18} /><strong>{agent.label}</strong><small>{agent.sessionCount} 个任务</small>
              </button>
              {!agentCollapsed && <div className="task-picker-agent-content">{agent.folders.map(folder => {
                const folderCollapsed = collapsedFolders.has(folder.key);
                return <section className={`task-picker-folder-group${folderCollapsed ? " is-collapsed" : ""}`} key={folder.key} aria-label={`${agent.label} · ${folder.label}`}>
                  <button type="button" className="task-picker-folder-header" aria-expanded={!folderCollapsed} onClick={() => toggleCollapsed(setCollapsedFolders, folder.key)}>
                    <ChevronDown size={14} className={`task-picker-chevron${folderCollapsed ? " is-collapsed" : ""}`} aria-hidden="true" />
                    <Folder size={15} aria-hidden="true" /><span title={folder.label}>{folder.label}</span><small>{folder.sessions.length}</small>
                  </button>
                  {!folderCollapsed && <div className="task-picker-folder-items">{folder.sessions.map(session => <TaskSessionItem key={session.id} session={session} currentId={currentId} openIds={openIds} onChoose={onChoose} />)}</div>}
                </section>;
              })}</div>}
            </section>;
          })}
        {!loading && !refreshing && !sessions.length && !error && <p className="task-picker-empty">没有找到任务，试试其他关键词</p>}
        {(loading || refreshing) && <p className="task-picker-empty" role="status"><LoaderCircle size={16} className="task-split-spinner" />{sessions.length ? "显示已有任务，正在后台更新…" : "正在加载任务…"}</p>}
        {cursor && !loading && !refreshing && <button className="task-picker-more" type="button" onClick={() => void load(query.trim(), cursor)}>加载更多任务</button>}
      </div>
    </section>
  </div>, document.body);
}
