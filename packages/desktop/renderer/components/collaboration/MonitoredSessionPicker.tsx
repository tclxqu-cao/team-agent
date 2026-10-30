import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import type { CatalogSession, MonitoredSession, SessionCatalogPage } from "../../../../core/src/domain/supervision/types";
import AgentBrandIcon from "../AgentBrandIcon";
import { AGENT_NAMES, collaborationRequest } from "./client";

export function mergeCatalogPage(previous: CatalogSession[], next: CatalogSession[]): CatalogSession[] {
  return [...new Map([...previous, ...next].map(session => [session.id, session])).values()];
}

export default function MonitoredSessionPicker({ value, onChange }: {
  value: MonitoredSession[];
  onChange: (sessions: MonitoredSession[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<SessionCatalogPage>({ data: [], nextCursor: null, total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const version = useRef(0);
  const pending = useRef(false);
  useEffect(() => {
    const current = ++version.current;
    let live = true;
    pending.current = true; setLoading(true); setError("");
    setPage({ data: [], nextCursor: null, total: 0 });
    const timer = setTimeout(() => {
      void collaborationRequest<SessionCatalogPage>({ action: "sessionCatalog", query, limit: 20 }).then(result => {
        if (live && current === version.current) setPage(result);
      }).catch(error => {
        if (live && current === version.current) setError(error instanceof Error ? error.message : "无法加载会话");
      }).finally(() => {
        if (live && current === version.current) { pending.current = false; setLoading(false); }
      });
    }, query ? 200 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [query, reload]);
  const more = async () => {
    if (pending.current || !page.nextCursor) return;
    const current = version.current;
    pending.current = true; setLoading(true); setError("");
    try {
      const result = await collaborationRequest<SessionCatalogPage>({ action: "sessionCatalog", query, limit: 20, cursor: page.nextCursor });
      if (current === version.current) setPage(old => ({ ...result, data: mergeCatalogPage(old.data, result.data) }));
    } catch (error) {
      if (current === version.current) setError(error instanceof Error ? error.message : "加载更多失败");
    } finally {
      if (current === version.current) { pending.current = false; setLoading(false); }
    }
  };
  const selected = new Set(value.map(session => session.id));
  return <section className="collab-monitor-picker" aria-label="关联原始会话">
    <div className="collab-monitor-heading"><strong>关联原始会话 <small>选填 · 已选 {value.length}</small></strong></div>
    <p className="collab-muted">运行中的在前。关联后作为监控对象，恢复或交接时才介入。</p>
    {value.length > 0 && <div className="collab-monitor-selected" aria-label="已选会话">{value.map(session => <span key={session.id} title={`${AGENT_NAMES[session.agentType]} · ${session.cwd}`}>
      <AgentBrandIcon agentType={session.agentType} size={14} /><span>{session.title}</span>
      <button type="button" aria-label={`取消关联${session.title}`} onClick={() => onChange(value.filter(item => item.id !== session.id))}><X size={13}/></button>
    </span>)}</div>}
    <label className="collab-monitor-search"><Search size={15}/><input aria-label="搜索所有原始会话" placeholder="搜索所有会话的标题、目录或 Agent" value={query} onChange={event => setQuery(event.target.value)} /></label>
    <div className="collab-monitor-results" aria-label="原始会话候选" aria-busy={loading} onScroll={event => {
      const element = event.currentTarget;
      if (element.scrollHeight - element.scrollTop - element.clientHeight < 64) void more();
    }}>
      {page.data.map(session => <label className="collab-monitor-row" key={session.id}>
        <input type="checkbox" aria-label={`关联${session.title}`} checked={selected.has(session.id)} disabled={!selected.has(session.id) && value.length >= 200} onChange={event => onChange(event.target.checked ? [...value, { id: session.id, agentType: session.agentType, title: session.title, cwd: session.cwd, projectId: session.projectId }] : value.filter(item => item.id !== session.id))} />
        <AgentBrandIcon agentType={session.agentType} size={18}/>
        <span><strong>{session.title}</strong><small>{AGENT_NAMES[session.agentType]} · {session.cwd}</small></span>
        <em className={session.status === "running" ? "is-running" : ""}>{session.status === "running" ? "运行中" : session.status === "failed" ? "异常" : session.status === "completed" ? "已完成" : "空闲"}</em>
      </label>)}
      {!loading && !error && !page.data.length && <p className="collab-muted">{query ? "没有匹配的会话" : "暂无可接入会话"}</p>}
      {loading && <p className="collab-muted" role="status">正在加载会话…</p>}
      {page.nextCursor && !error && <button type="button" className="collab-monitor-more" disabled={loading} onClick={() => void more()}>加载更多（已显示 {page.data.length} / {page.total}）</button>}
    </div>
    {error && <p className="collab-error" role="alert">{error} <button type="button" onClick={() => setReload(current => current + 1)}>重新加载</button></p>}
  </section>;
}
