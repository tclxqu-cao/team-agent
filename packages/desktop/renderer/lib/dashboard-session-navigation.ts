import type { MonitoredSession } from "../../../core/src/domain/supervision/types";
import type { AgentApi, UnifiedSessionSummary } from "../global";
import type { AgentRailSessions } from "./agent-rail-sessions";

/** Open the exact target without scanning every workspace's session history. */
export async function resolveDashboardSession(api: AgentApi, target: MonitoredSession, signal: AbortSignal, cached?: AgentRailSessions): Promise<{ session: UnifiedSessionSummary; snapshot: AgentRailSessions }> {
  signal.throwIfAborted();
  const detail = await api.getSession(target.id, { limit: 1 }) as UnifiedSessionSummary & { messages?: unknown; events?: unknown; history?: unknown };
  signal.throwIfAborted();
  if (!detail?.id || detail.id !== target.id || detail.agentType !== target.agentType) throw new Error("原会话身份不匹配，请刷新看板后重试");
  const snapshot: AgentRailSessions = {
    workspaces: cached?.workspaces.filter(workspace => workspace.agentType === target.agentType) ?? [],
    sessions: cached?.sessions.filter(session => session.agentType === target.agentType && session.id !== target.id) ?? [],
  };
  const known = cached?.sessions.find(session => session.id === target.id);
  const projectId = detail.projectId ?? known?.projectId ?? target.projectId;
  const findWorkspace = () => snapshot.workspaces.find(workspace => workspace.workspaceId === projectId)
    ?? snapshot.workspaces.find(workspace => workspace.roots.includes(detail.cwd || target.cwd));
  let workspace = findWorkspace();
  let cursor: string | null = null;
  const cursors = new Set<string>();
  while (!workspace) {
    const page = await api.listAgentWorkspaces(target.agentType, { cursor, limit: 200 });
    signal.throwIfAborted();
    if (page.stale) throw new Error("会话目录待刷新，请重试");
    snapshot.workspaces = [...new Map([...snapshot.workspaces, ...page.data].map(item => [item.workspaceId, item])).values()];
    workspace = findWorkspace();
    cursor = page.nextCursor;
    if (workspace || !cursor) break;
    if (cursors.has(cursor)) throw new Error("会话目录加载中断，请重试");
    cursors.add(cursor);
  }
  const workspaceId = workspace?.workspaceId ?? projectId ?? `session-${detail.id}`;
  if (!workspace) snapshot.workspaces.push({ agentType: target.agentType, workspaceId, roots: [detail.cwd || target.cwd], name: (detail.cwd || target.cwd).split(/[\\/]/).filter(Boolean).at(-1) || "会话工作区", order: snapshot.workspaces.length, source: "derived", canCreateSession: false });
  const { messages: _messages, events: _events, history: _history, ...summary } = detail;
  const session = { ...summary, cwd: detail.cwd || target.cwd, projectId: workspaceId };
  snapshot.sessions.push(session);
  return { session, snapshot };
}
