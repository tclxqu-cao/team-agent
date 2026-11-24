import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Folder, FolderTree, List, LoaderCircle, Search, X } from "lucide-react";
import type { CatalogSession, SessionCatalogPage } from "../../../../core/src/domain/supervision/types";
import { collaborationRequest, AGENT_NAMES } from "../collaboration/client";
import AgentBrandIcon from "../AgentBrandIcon";
import SessionDisclosureButton from "../SessionDisclosureButton";
import SessionStatusDot from "../SessionStatusDot";
import { mergeCatalogSessions } from "../../lib/all-sessions";
import { readAllSessionsCache } from "../../lib/all-sessions-cache";
import { buildSessionTree, includeSessionAncestors, type SessionTreeNode } from "../../lib/session-tree";
import { useSessionActivity } from "../../lib/use-session-activity";
import { useSessionDisclosure } from "../../lib/use-session-disclosure";
import { readTaskCatalogCache, readTaskCatalogWindow, writeTaskCatalogCache, type TaskCatalogWindow } from "./task-session-catalog";

interface Props {
  currentId?: string;
  openIds: ReadonlySet<string>;
  knownSessions?: CatalogSession[];
  onChoose(session: CatalogSession): void;
  onClose(): void;
}

function matchingSessions(sessions: CatalogSession[], query: string): CatalogSession[] {
  const search = query.trim().toLocaleLowerCase();
  const matches = sessions.filter(session => `${session.title} ${session.cwd} ${session.agentType}`.toLocaleLowerCase().includes(search));
  return includeSessionAncestors(matches, sessions);
}

interface TaskFolderGroup {
  key: string;
  label: string;
  sessions: SessionTreeNode<CatalogSession>[];
}

interface TaskAgentGroup {
  key: CatalogSession["agentType"];
  label: string;
  folders: TaskFolderGroup[];
  sessionCount: number;
}

/** Preserve the catalog's relevance order while adding a stable Agent → folder hierarchy. */
export function groupTaskSessions(sessions: readonly SessionTreeNode<CatalogSession>[]): TaskAgentGroup[] {
  const agents = new Map<CatalogSession["agentType"], { folders: Map<string, TaskFolderGroup>; sessionCount: number }>();
  for (const node of sessions) {
    const { session } = node;
    const agent = agents.get(session.agentType) ?? { folders: new Map<string, TaskFolderGroup>(), sessionCount: 0 };
    const folder = session.cwd?.trim() || "未指定文件夹";
    const folderKey = session.cwd?.trim() || "__unknown__";
    const existingFolder = agent.folders.get(folderKey);
    if (existingFolder) existingFolder.sessions.push(node);
    else agent.folders.set(folderKey, { key: `${session.agentType}:${folderKey}`, label: folder, sessions: [node] });
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
    <SessionStatusDot session={session} active={session.id === currentId} />
    <AgentBrandIcon agentType={session.agentType} size={20} /><span className="task-picker-item-text"><strong>{session.title || "未命名任务"}</strong><small>{AGENT_NAMES[session.agentType]} · {session.cwd || "未指定目录"}</small></span>
    <em>{session.id === currentId ? "当前任务" : openIds.has(session.id) ? "已在分屏" : session.status === "running" ? "进行中" : ""}</em>
  </button>;
}

export default function TaskSessionPicker({ currentId, openIds, knownSessions = [], onChoose, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [viewMode, setViewMode] = useState<"grouped" | "list">("grouped");
  const [collapsedAgents, setCollapsedAgents] = useState<ReadonlySet<string>>(new Set());
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(new Set());
  const disclosure = useSessionDisclosure();
  const activity = useSessionActivity();
  const liveById = useMemo(() => new Map(activity?.sessions.map(session => [session.id, session])), [activity]);
  const [initialCache] = useState(() => readTaskCatalogCache() ?? { rows: readAllSessionsCache()?.data ?? [], count: 0 });
  const available = useRef(initialCache);
  const snapshot = useRef<TaskCatalogWindow>({ ...initialCache, cursor: null });
  const [catalog, setCatalog] = useState(snapshot.current);
  const sessions = useMemo(() => mergeCatalogSessions(catalog.rows, matchingSessions(knownSessions, query)), [catalog.rows, knownSessions, query]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const retryMore = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const refreshTimer = useRef<number>();
  const close = useRef(onClose);
  close.current = onClose;
  const load = async (search: string, more = false) => {
    if (request.current) return;
    window.clearTimeout(refreshTimer.current);
    const controller = new AbortController();
    request.current = controller;
    retryMore.current = more;
    setLoading(true); setError(null);
    try {
      const next = await readTaskCatalogWindow((cursor, limit) => collaborationRequest<SessionCatalogPage>({
        action: "sessionCatalog", query: search, cursor, limit, backgroundRefresh: !cursor,
      }, { signal: controller.signal }), snapshot.current, more, controller.signal);
      if (controller.signal.aborted) return;
      snapshot.current = next;
      setCatalog(next);
      if (!search && !next.refreshing) {
        available.current = next;
        writeTaskCatalogCache(next);
      }
      if (next.refreshing) refreshTimer.current = window.setTimeout(() => { void load(search, more); }, 2_000);
    } catch (failure) {
      if (!controller.signal.aborted) {
        setCatalog(previous => previous.refreshing ? { ...previous, refreshing: false } : previous);
        const message = failure instanceof Error ? failure.message : "无法加载任务";
        setError(/timeout|timed out/i.test(message) ? "任务列表更新超时，请重试" : message);
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoading(false);
      }
    }
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close.current(); }
    };
    document.addEventListener("keydown", keydown, true);
    return () => { document.removeEventListener("keydown", keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const search = query.trim();
    const cached = available.current;
    snapshot.current = { rows: matchingSessions(cached.rows, search), count: search ? 0 : cached.count, cursor: null };
    setCatalog(snapshot.current); setLoading(true); setError(null);
    const timer = window.setTimeout(() => { void load(search); }, search ? 200 : 0);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(refreshTimer.current);
      request.current?.abort();
      request.current = null;
    };
  }, [query]);
  const { cursor, refreshing } = catalog;
  const tree = useMemo(() => buildSessionTree(sessions), [sessions]);
  const groups = useMemo(() => groupTaskSessions(tree), [tree]);
  const renderSession = ({ session, children }: SessionTreeNode<CatalogSession>): React.ReactNode => {
    const expanded = disclosure.expandedIds.has(session.id);
    const live = liveById.get(session.id);
    const row = live && (live.status === "running" || live.updated >= session.updated) ? { ...session, ...live } : session;
    return <div key={session.id}>
      <div className="task-picker-session-row">
        <TaskSessionItem session={row} currentId={currentId} openIds={openIds} onChoose={onChoose} />
        {children.length > 0 && <SessionDisclosureButton title={session.title} expanded={expanded}
          onToggle={() => disclosure.toggle(session.id)} />}
      </div>
      {expanded && children.length > 0 && <div className="task-picker-session-children" role="group" aria-label={`${session.title}的子会话`}>
        {children.map(renderSession)}
      </div>}
    </div>;
  };
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
          <button type="button" className={`task-picker-view-button${viewMode === "list" ? " is-active" : ""}`} aria-pressed={viewMode === "list"} onClick={() => setViewMode("list")}><List size={14} aria-hidden="true" />列表</button>
        </div>
        <button type="button" className="ui-icon-button" onClick={onClose} aria-label="关闭任务选择"><X size={18} /></button>
      </div></header>
      <label className="task-picker-search"><Search size={16} aria-hidden="true" /><input ref={input} value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务、目录或 Agent" aria-label="搜索分屏任务" /></label>
      {error && <div className="task-picker-error" role="alert">{error}<button type="button" onClick={() => void load(query.trim(), retryMore.current)}>重试</button></div>}
      <div className="task-picker-list" aria-busy={!tree.length && (loading || refreshing)}>
        {viewMode === "list" ? tree.map(renderSession)
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
                  {!folderCollapsed && <div className="task-picker-folder-items">{folder.sessions.map(renderSession)}</div>}
                </section>;
              })}</div>}
            </section>;
          })}
        {!loading && !refreshing && !tree.length && !error && <p className="task-picker-empty">没有找到任务，试试其他关键词</p>}
        {(loading || refreshing) && <p className="task-picker-empty" role="status"><LoaderCircle size={16} className="task-split-spinner" />{tree.length ? "显示已有任务，正在后台更新…" : "正在加载任务…"}</p>}
        {cursor && !refreshing && <button className="task-picker-more" type="button" disabled={loading} onClick={() => void load(query.trim(), true)}>加载更多任务</button>}
      </div>
    </section>
  </div>, document.body);
}
