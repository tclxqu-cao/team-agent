import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Search } from "lucide-react";
import type { SessionActivity } from "@agent/core/domain/session/SessionActivity";
import type { AgentType, RuntimeHealth, UnifiedSessionSummary } from "../global";
import { loadAgentRailSessions, type AgentRailSessions } from "../lib/agent-rail-sessions";
import { sortRunningSessionsFirst } from "../lib/sidebar-session-sort";
import { getSidebarSessionVisualState, SIDEBAR_SESSION_STATUS_LABELS } from "../lib/sidebar-session-status";
import AgentWorkspaceSwitcher from "./AgentWorkspaceSwitcher";
import CloudMigrationDialog from "./CloudMigrationDialog";
import AgentBrandIcon from "./AgentBrandIcon";
import SidebarSessionRow from "./SidebarSessionRow";

interface AgentSessionRailProps {
  hidden: boolean;
  value: AgentType;
  health: RuntimeHealth[];
  selectedSessionId: string | null;
  getActivity(session: UnifiedSessionSummary): SessionActivity;
  onChange(agentType: AgentType): void;
  onUnavailable(message: string): void;
  onSelect(session: UnifiedSessionSummary, snapshot: AgentRailSessions): void;
}

export default function AgentSessionRail({ hidden, value, health, selectedSessionId, getActivity, onChange, onUnavailable, onSelect }: AgentSessionRailProps) {
  const [preview, setPreview] = useState<{ agentType: AgentType; label: string; top: number; unavailableMessage?: string } | null>(null);
  const [migration, setMigration] = useState<{ id: string; title: string } | null>(null);
  const [snapshot, setSnapshot] = useState<AgentRailSessions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [revision, setRevision] = useState(0);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();
  const panel = useRef<HTMLDivElement>(null);
  const cache = useRef(new Map<AgentType, AgentRailSessions>());
  const keepOpen = () => clearTimeout(closeTimer.current);
  const close = () => { keepOpen(); setPreview(null); };
  const scheduleClose = () => { keepOpen(); closeTimer.current = setTimeout(() => setPreview(null), 180); };

  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => { if (hidden) setPreview(null); }, [hidden]);
  useEffect(() => {
    if (!preview || hidden) return;
    const controller = new AbortController();
    setQuery("");
    setSnapshot(preview.unavailableMessage ? null : cache.current.get(preview.agentType) ?? null);
    setError(preview.unavailableMessage ?? null);
    setLoading(!preview.unavailableMessage);
    if (!preview.unavailableMessage) {
      void loadAgentRailSessions(window.agentApi, preview.agentType, controller.signal).then(next => {
        if (controller.signal.aborted) return;
        cache.current.set(preview.agentType, next);
        setSnapshot(next);
      }).catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "会话加载失败，请重试");
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }
    return () => controller.abort();
  }, [preview?.agentType, preview?.unavailableMessage, hidden, revision]);

  const sessions = sortRunningSessionsFirst(snapshot?.sessions ?? [], session => {
    const activity = getActivity(session);
    return activity === "running" || activity === "needs-input";
  }).filter(session => session.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const dismissOnBlur = (event: React.FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (!event.currentTarget.contains(next) && !panel.current?.contains(next)) scheduleClose();
  };

  return <>
    <aside className="sidebar-agent-rail" aria-label="Agent 快捷栏" aria-hidden={hidden}
      ref={element => { if (element) element.inert = hidden; }}
      onPointerEnter={keepOpen} onPointerLeave={scheduleClose} onBlur={dismissOnBlur}
      onKeyDown={event => { if (event.key === "Escape") close(); }}>
      <AgentWorkspaceSwitcher vertical value={value} health={health} onChange={onChange} onUnavailable={onUnavailable}
        onPreview={(agentType, label, anchor, unavailableMessage) => {
          keepOpen();
          if (preview?.agentType !== agentType) setSnapshot(null);
          setPreview({ agentType, label, top: Math.max(56, Math.min(anchor.top, window.innerHeight - 380)), unavailableMessage });
        }} />
    </aside>
    {!hidden && preview && createPortal(<div ref={panel} className="agent-session-flyout" style={{ top: preview.top, maxHeight: Math.min(600, window.innerHeight - preview.top - 12) }}
      role="dialog" aria-label={`${preview.label} 会话`} onPointerEnter={keepOpen} onPointerLeave={scheduleClose}
      onFocus={keepOpen} onBlur={dismissOnBlur} onKeyDown={event => { if (event.key === "Escape") close(); }}>
      <header><AgentBrandIcon agentType={preview.agentType} size={20} /><strong>{preview.label}</strong><span>会话 {snapshot?.sessions.length ?? ""}</span></header>
      <label className="agent-session-flyout-search"><Search size={15} aria-hidden="true" /><input aria-label={`搜索 ${preview.label} 会话`} placeholder="搜索会话" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="agent-session-flyout-list" aria-busy={loading}>
        {sessions.map(session => {
          const visualState = getSidebarSessionVisualState(getActivity(session));
          return <SidebarSessionRow key={session.id} session={{ id: session.id, title: session.title, visualState,
            statusLabel: SIDEBAR_SESSION_STATUS_LABELS[visualState], occupiedExternally: session.occupancy === "owned-externally",
            canDelete: false, active: value === preview.agentType && selectedSessionId === session.id, compatibility: session.compatibility }}
            onSelect={() => { if (snapshot) onSelect(session, snapshot); close(); }}
            onMigrateToCloud={() => setMigration({ id: session.id, title: session.title })} />;
        })}
        {loading && <p className="agent-session-flyout-message" role="status"><LoaderCircle size={15} className="spin" />正在加载会话…</p>}
        {error && <p className="agent-session-flyout-message" role="alert">{error}{!preview.unavailableMessage && <button type="button" onClick={() => setRevision(current => current + 1)}>重试</button>}</p>}
        {!loading && !error && !sessions.length && <p className="agent-session-flyout-message">{query ? "没有匹配的会话" : "暂无会话"}</p>}
      </div>
    </div>, document.body)}
    {migration && <CloudMigrationDialog sessionId={migration.id} sessionTitle={migration.title} onClose={() => {
      setMigration(null);
      setRevision(current => current + 1);
    }} />}
  </>;
}
