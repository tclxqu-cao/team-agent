import { useEffect, useState } from "react";
import { Activity, ArrowRight, ChevronDown, Layers, List, Pause, Play, RefreshCw, ShieldCheck, Users, X } from "lucide-react";
import type { AgentType } from "../../../../core/src/domain/agent/agent-type";
import type { DashboardGroup, MonitoredSession, SessionDashboardSnapshot, SupervisionIncident } from "../../../../core/src/domain/supervision/types";
import { SESSION_DASHBOARD_READY } from "../../../../core/src/domain/web-console/SessionDashboardBridge";
import { postDashboardIntent } from "../../lib/dashboard-navigation-delivery";
import { useUIStore } from "../../stores/uiStore";
import AgentBrandIcon from "../AgentBrandIcon";
import { AGENT_NAMES, DISCUSSION_STATUS, collaborationRequest } from "./client";
import DashboardDecision from "./DashboardDecision";
import { useSessionDashboard } from "./useSessionDashboard";
import "./collaboration.css";
import "./session-dashboard.css";

interface DashboardProps {
  onOpenGroup?: (group: DashboardGroup) => void;
  onOpenSession?: (session: MonitoredSession) => void;
  onViewAgent?: (agentType: AgentType) => void;
  onViewGroups?: () => void;
  onClose?: () => void;
}

export function SupervisionIncidentDecision({ incident, target, refresh, onOpen }: {
  incident: SupervisionIncident; target: MonitoredSession; refresh: () => Promise<void>; onOpen: (target: MonitoredSession) => void;
}) {
  return <DashboardDecision text={incident.message} options={incident.question?.options ?? incident.options} recommendation={incident.recommendation}
    multiSelect={incident.question?.multiSelect} sourceOnly={incident.question?.requiresSource}
    onSource={() => onOpen(target)} onAnswer={async (answer, selectedIndices) => {
      await collaborationRequest({ action: "answerSupervision", groupId: incident.groupId, incidentId: incident.id, answer, selectedIndices });
      await refresh();
    }}/>;
}

function GroupCard({ item, onOpenGroup, onOpenSession, refresh }: { item: DashboardGroup; onOpenGroup: (group: DashboardGroup) => void; onOpenSession: (session: MonitoredSession) => void; refresh: () => Promise<void> }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = item.supervision;
  const supervisor = (scope?.group ?? item.group).members.find(member => member.id === (scope?.group ?? item.group).monitoring?.supervisorId);
  const pending = scope?.incidents.filter(incident => incident.status === "waiting") ?? [];
  const act = async (action: "apply" | "pause") => {
    setBusy(true); setError("");
    try {
      await collaborationRequest(action === "apply" ? { action: "applySupervision", groupId: item.group.id } : { action: "pauseSupervision", groupId: item.group.id, paused: !scope?.paused });
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  };
  return <article className={`session-dashboard-group is-${item.status}`}>
    <header><button className="session-dashboard-title" onClick={() => onOpenGroup(item)}><Users size={18}/><strong>{item.group.name}</strong></button><span className={`session-dashboard-status is-${item.status}`}>{DISCUSSION_STATUS[item.status]}</span></header>
    <p className="session-dashboard-progress">{item.progress}</p>
    <div className="session-dashboard-meta"><span>{item.runningCount} 运行中</span><span className={item.decisionCount ? "needs-attention" : ""}>{item.decisionCount} 待决策</span>{supervisor && <span><ShieldCheck size={13}/>{supervisor.name}{scope?.paused ? " · 已暂停监管" : " · 监工"}</span>}</div>
    <details className="session-dashboard-linked"><summary><span>{item.sessions.length ? `${item.sessions.length} 条${(scope?.group ?? item.group).monitoring?.targets.length ? "原始" : "群内"}会话` : "暂无工作会话"}</span><ChevronDown size={15}/></summary>
      <div>{item.sessions.map(session => <button className="session-dashboard-session" key={session.id} onClick={() => onOpenSession(session)}><AgentBrandIcon agentType={session.agentType} size={17}/><span><strong>{session.title}</strong><small>{AGENT_NAMES[session.agentType]}</small></span><em>{session.status === "running" ? "运行中" : session.status === "failed" ? "异常" : session.status === "unknown" ? "待核对" : "空闲"}</em><ArrowRight size={14}/></button>)}</div>
    </details>
    {supervisor && <details className="session-dashboard-policy"><summary>监工职责</summary><p>{supervisor.role || "关注意外中断与交接断档，在原任务授权内恢复；业务选择交由你决策。"}</p><button disabled={busy} onClick={() => void act("pause")}>{scope?.paused ? <Play size={13}/> : <Pause size={13}/>} {scope?.paused ? "恢复监管" : "暂停监管"}</button></details>}
    {item.configurationChanged && <p className="session-dashboard-config">群配置已更新，当前监工沿用原配置。<button disabled={busy} onClick={() => void act("apply")}>应用最新监管配置</button></p>}
    {item.questions.map(question => <DashboardDecision key={`${question.discussionId}:${question.questionId}`} text={question.text} options={question.options}
      onSource={() => onOpenGroup({ ...item, discussionId: question.discussionId })}
      onAnswer={async (answer, selectedIndices) => { await collaborationRequest(question.decisionRevision !== undefined ? { action: "answerDecision", discussionId: question.discussionId, expectedRevision: question.decisionRevision, answer, messageId: crypto.randomUUID() } : { action: "answer", discussionId: question.discussionId, questionId: question.questionId, answer, selectedIndices }); await refresh(); }}/>) }
    {pending.map(incident => {
      const target = scope?.group.monitoring?.targets.find(target => target.id === incident.sessionId);
      return target ? <SupervisionIncidentDecision key={incident.id} incident={incident} target={target} refresh={refresh} onOpen={onOpenSession}/> : null;
    })}
    {!!scope?.incidents.length && <details className="session-dashboard-history"><summary>监工记录</summary>{scope.incidents.slice(-6).reverse().map(incident => <p key={incident.id}><time>{new Date(incident.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time> {incident.message} <small>{incident.status === "verifying" ? "核对新进度中" : incident.status === "resolved" ? "已处理" : incident.status === "waiting" ? "等你处理" : incident.status === "dismissed" ? "已结束" : "处理中"}</small></p>)}</details>}
    {error && <p className="collab-error" role="alert">{error}</p>}
    <footer><span title={item.group.cwd}>{item.group.cwd.split(/[\\/]/).filter(Boolean).at(-1) || item.group.cwd}</span><button onClick={() => onOpenGroup(item)}>进入群聊 <ArrowRight size={14}/></button></footer>
  </article>;
}

function RunningSessionCard({ session, showAgent = false, onOpen }: { session: MonitoredSession; showAgent?: boolean; onOpen: (session: MonitoredSession) => void }) {
  return <button className="session-dashboard-agent-session" onClick={() => onOpen(session)}>
    {showAgent ? <span className="session-dashboard-session-brand" role="img" aria-label={AGENT_NAMES[session.agentType]} title={AGENT_NAMES[session.agentType]}><AgentBrandIcon agentType={session.agentType} size={20}/></span> : <span className="session-dashboard-running-dot"/>}
    <span><strong>{session.title}</strong><small title={session.cwd}>{session.cwd}</small></span><span>运行中</span><ArrowRight size={15}/>
  </button>;
}

type DashboardEntry = { id: string; updated: string; priority: number } & (
  | { kind: "group"; item: DashboardGroup }
  | { kind: "session"; item: MonitoredSession }
);

function mergedDashboardEntries(snapshot: SessionDashboardSnapshot): DashboardEntry[] {
  const groups: DashboardEntry[] = snapshot.groups.map(item => ({
    kind: "group", id: `group:${item.group.id}`, updated: item.updated, item,
    priority: item.decisionCount > 0 || item.status === "waiting" ? 2 : Number(item.runningCount > 0 || item.status === "running"),
  }));
  const sessions: DashboardEntry[] = snapshot.agents.flatMap(agent => agent.sessions).map(item => ({
    kind: "session", id: `session:${item.id}`, updated: item.updated, priority: 1, item,
  }));
  return [...groups, ...sessions].sort((a, b) => b.priority - a.priority || b.updated.localeCompare(a.updated) || a.id.localeCompare(b.id));
}

export default function SessionDashboard(props: DashboardProps) {
  const { snapshot, error, loading, refresh } = useSessionDashboard();
  const skin = useUIStore(state => state.skin);
  const sessionsMerged = useUIStore(state => state.dashboardSessionsMerged);
  const setSessionsMerged = useUIStore(state => state.setDashboardSessionsMerged);
  useEffect(() => { document.documentElement.setAttribute("data-skin", skin); }, [skin]);
  useEffect(() => { if (!loading && window.parent !== window) window.parent.postMessage({ type: SESSION_DASHBOARD_READY }, window.location.origin); }, [loading]);
  const openGroup = props.onOpenGroup ?? ((item: DashboardGroup) => postDashboardIntent({ kind: "group", groupId: item.group.id, title: item.group.name, discussionId: item.discussionId }));
  const openSession = props.onOpenSession ?? ((session: MonitoredSession) => postDashboardIntent({ kind: "session", session }));
  const viewGroups = props.onViewGroups ?? (() => postDashboardIntent({ kind: "groups" }));
  const running = snapshot?.agents.reduce((count, agent) => count + agent.sessions.length, 0) ?? 0;
  const mergedEntries = snapshot && sessionsMerged ? mergedDashboardEntries(snapshot) : [];
  const decisions = snapshot?.decisionTotal ?? snapshot?.groups.reduce((count, group) => count + group.decisionCount, 0) ?? 0;
  return <main className="session-dashboard">
    <header className="session-dashboard-heading"><div><span className="collab-eyebrow">会话总览</span><h1>Dashboard <span className="session-dashboard-live"><i/>实时</span></h1><p>在一个地方查看运行、交接与需要你决定的事。</p></div><div className="session-dashboard-toolbar"><button onClick={() => setSessionsMerged(!sessionsMerged)} aria-pressed={sessionsMerged} title={sessionsMerged ? "恢复按 Agent 分组" : "合并显示群聊和所有 Agent 的运行会话"}>{sessionsMerged ? <Layers size={16}/> : <List size={16}/>}<span>{sessionsMerged ? "按 Agent 分组" : "合并会话"}</span></button><button onClick={() => void refresh()} aria-label="刷新会话看板"><RefreshCw size={16}/></button><button onClick={viewGroups}><Users size={16}/>群聊列表</button>{props.onClose && <button onClick={props.onClose} aria-label="关闭会话看板"><X size={17}/></button>}</div></header>
    <div className="session-dashboard-stats"><span><Activity size={16}/><strong>{running}</strong>运行中的原始会话</span><span className={decisions ? "needs-attention" : ""}><strong>{decisions}</strong>待你决策</span><span><strong>{snapshot?.groupTotal ?? 0}</strong>协作群</span><small>无变化时监工保持安静</small></div>
    {error && <p role="alert" className="collab-error">{error}<button onClick={() => void refresh()}>重试</button></p>}
    {snapshot?.discoveryError && <p role="alert" className="collab-error">原生会话状态暂时不可用：{snapshot.discoveryError}</p>}
    {loading && !snapshot && <p role="status">正在加载会话总览…</p>}
    {snapshot && !sessionsMerged && (snapshot.groups.length ? <section aria-label="群聊运行总览"><div className="session-dashboard-section-title"><h2><Users size={18}/>群聊 <small>Top 10 · 运行中和待决策优先</small></h2><button onClick={viewGroups}>查看全部 {snapshot.groupTotal} <ArrowRight size={14}/></button></div>
      <div className="session-dashboard-group-grid">{snapshot.groups.map(item => <GroupCard key={item.group.id} item={item} onOpenGroup={openGroup} onOpenSession={openSession} refresh={refresh}/>)}</div>
    </section> : <div className="session-dashboard-group-create"><button onClick={viewGroups}><Users size={16}/>创建群聊，配置监工</button></div>)}
    {snapshot && (sessionsMerged ? <section className="session-dashboard-agent" aria-label="合并会话"><div className="session-dashboard-section-title"><h2><Activity size={20}/>会话 <small>{running} 运行中 · {snapshot.groupTotal} 群聊</small></h2></div>
      {mergedEntries.length ? <div className="session-dashboard-agent-grid">{mergedEntries.map(entry => entry.kind === "group"
        ? <GroupCard key={entry.id} item={entry.item} onOpenGroup={openGroup} onOpenSession={openSession} refresh={refresh}/>
        : <RunningSessionCard key={entry.id} session={entry.item} showAgent onOpen={openSession}/>)}</div> : <p className="session-dashboard-agent-empty">当前没有运行中的会话</p>}
    </section> : snapshot.agents.map(agent => <section className="session-dashboard-agent" key={agent.agentType} aria-label={`${AGENT_NAMES[agent.agentType]} 运行会话`}><div className="session-dashboard-section-title"><h2><AgentBrandIcon agentType={agent.agentType} size={20}/>{AGENT_NAMES[agent.agentType]} <small>{agent.sessions.length} 运行中</small></h2><button onClick={() => props.onViewAgent ? props.onViewAgent(agent.agentType) : postDashboardIntent({ kind: "agent", agentType: agent.agentType })}>查看全部 <ArrowRight size={14}/></button></div>
      {agent.sessions.length ? <div className="session-dashboard-agent-grid">{agent.sessions.map(session => <RunningSessionCard key={session.id} session={session} onOpen={openSession}/>)}</div> : <p className="session-dashboard-agent-empty">当前没有运行中的会话</p>}
    </section>))}
  </main>;
}
