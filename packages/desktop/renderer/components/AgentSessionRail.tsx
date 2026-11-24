import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Plus, Search } from "lucide-react";
import type { SessionActivity } from "@agent/core/domain/session/SessionActivity";
import type { AgentType, RuntimeHealth, UnifiedSessionSummary } from "../../../shared/src/contracts/agent-api";
import { loadAgentRailSessions, type AgentRailSessions } from "../lib/agent-rail-sessions";
import { availableAgentTypes } from "../lib/agent-availability";
import { sortRunningSessionsFirst } from "../lib/sidebar-session-sort";
import { sessionCompletedAt, getSidebarSessionVisualState, SIDEBAR_SESSION_STATUS_LABELS } from "../lib/sidebar-session-status";
import { buildSessionTree, includeSessionAncestors, type SessionTreeNode } from "../lib/session-tree";
import { useSessionDisclosure } from "../lib/use-session-disclosure";
import AgentWorkspaceSwitcher from "./AgentWorkspaceSwitcher";
import AgentBrandIcon from "./AgentBrandIcon";
import SidebarSessionRow from "./SidebarSessionRow";

interface AgentSessionRailProps {
  hidden: boolean;
  value: AgentType;
  health: RuntimeHealth[];
  selectedSessionId: string | null;
  getActivity(session: UnifiedSessionSummary): SessionActivity;
  onChange(agentType: AgentType): void;
  onNewSession(agentType: AgentType): void;
  onSelect(session: UnifiedSessionSummary, snapshot: AgentRailSessions): void;
}

export default function AgentSessionRail({ hidden, value, health, selectedSessionId, getActivity, onChange, onNewSession, onSelect }: AgentSessionRailProps) {
  const [preview, setPreview] = useState<{ agentType: AgentType; label: string; top: number } | null>(null);
  const [snapshot, setSnapshot] = useState<AgentRailSessions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const disclosure = useSessionDisclosure();
  const [revision, setRevision] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const panel = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<AgentType, AgentRailSessions>());
  const keepOpen = () => clearTimeout(closeTimer.current);
  const close = () => { keepOpen(); setPreview(null); };
  const scheduleClose = () => { keepOpen(); closeTimer.current = setTimeout(() => setPreview(null), 180); };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const previewAvailable = Boolean(preview && availableAgentTypes(health).includes(preview.agentType));
  useEffect(() => { if (hidden || !previewAvailable) setPreview(null); }, [hidden, previewAvailable]);
  useEffect(() => {
    if (!preview || hidden || !previewAvailable) return;
    const controller = new AbortController();
    setQuery("");
    setSnapshot(cache.current.get(preview.agentType) ?? null);
    setError(null);
    setLoading(true);
    void loadAgentRailSessions(window.agentApi, preview.agentType, controller.signal).then(next => {
      if (controller.signal.aborted) return;
      cache.current.set(preview.agentType, next);
      setSnapshot(next);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "会话加载失败，请重试");
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [preview?.agentType, previewAvailable, hidden, revision]);

  const sessions = sortRunningSessionsFirst(snapshot?.sessions ?? [], session => {
    const activity = getActivity(session);
    return activity === "running" || activity === "needs-input";
  });
  const search = query.trim().toLocaleLowerCase();
  const tree = buildSessionTree(search
    ? includeSessionAncestors(sessions.filter(session => session.title.toLocaleLowerCase().includes(search)), sessions)
    : sessions);
  const renderSession = ({ session, children }: SessionTreeNode<UnifiedSessionSummary>): React.ReactNode => {
    const visualState = getSidebarSessionVisualState(getActivity(session));
    const expanded = disclosure.expandedIds.has(session.id);
    return <div key={session.id}>
      <SidebarSessionRow session={{ id: session.id, title: session.title, visualState,
        statusLabel: SIDEBAR_SESSION_STATUS_LABELS[visualState], occupiedExternally: session.occupancy === "owned-externally",
        completedAt: sessionCompletedAt(session),
        canDelete: false, active: value === preview?.agentType && selectedSessionId === session.id,
        compatibility: session.compatibility, child: Boolean(session.parentSessionId), expanded }}
        onToggleChildren={children.length ? () => disclosure.toggle(session.id) : undefined}
        onSelect={() => { if (snapshot) onSelect(session, snapshot); close(); }} />
      {expanded && children.length > 0 && <div className="sidebar-session-children" role="group" aria-label={`${session.title}的子会话`}>
        {children.map(renderSession)}
      </div>}
    </div>;
  };
  const dismissOnBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!event.currentTarget.contains(next) && !panel.current?.contains(next)) scheduleClose();
  };

  return <>
    <aside className="sidebar-agent-rail" aria-label="Agent 快捷栏" aria-hidden={hidden}
      ref={element => { if (element) element.inert = hidden; }}
      onPointerEnter={keepOpen} onPointerLeave={scheduleClose} onBlur={dismissOnBlur}
      onKeyDown={event => { if (event.key === "Escape") close(); }}>
      <AgentWorkspaceSwitcher vertical value={value} health={health} onChange={onChange}
        onPreview={(agentType, label, anchor) => {
          keepOpen();
          if (preview?.agentType !== agentType) {
            setSnapshot(null);
            disclosure.collapseAll();
          }
          setPreview({ agentType, label, top: Math.max(56, Math.min(anchor.top, window.innerHeight - 380)) });
        }} />
    </aside>
    {!hidden && previewAvailable && preview && createPortal(<div ref={panel} className="agent-session-flyout" style={{ top: preview.top, maxHeight: Math.min(600, window.innerHeight - preview.top - 12) }}
      role="dialog" aria-label={`${preview.label} 会话`} onPointerEnter={keepOpen} onPointerLeave={scheduleClose}
      onFocus={keepOpen} onBlur={dismissOnBlur} onKeyDown={event => { if (event.key === "Escape") close(); }}>
      <header>
        <AgentBrandIcon agentType={preview.agentType} size={20} /><strong>{preview.label}</strong>
        <span>会话 {snapshot?.sessions.length ?? ""}</span>
        <button type="button" className="agent-session-flyout-new"
          aria-label={`新建 ${preview.label} 会话`} title="在小窗口中新建会话"
          onClick={() => { onNewSession(preview.agentType); close(); }}>
          <Plus size={14} aria-hidden="true" /><span>新建会话</span>
        </button>
      </header>
      <label className="agent-session-flyout-search"><Search size={15} aria-hidden="true" /><input aria-label={`搜索 ${preview.label} 会话`} placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="agent-session-flyout-list" aria-busy={loading}>
        {tree.map(renderSession)}
        {loading && <p className="agent-session-flyout-message" role="status"><LoaderCircle size={15} className="spin" />正在加载会话…</p>}
        {error && <p className="agent-session-flyout-message" role="alert">{error}<button type="button" onClick={() => setRevision(current => current + 1)}>重试</button></p>}
        {!loading && !error && !tree.length && <p className="agent-session-flyout-message">{query ? "没有匹配的会话" : "暂无会话"}</p>}
      </div>
    </div>, document.body)}
  </>;
}
