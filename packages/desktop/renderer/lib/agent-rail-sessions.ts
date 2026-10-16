import type { AgentApi, AgentType, AgentWorkspace, UnifiedSessionSummary, WorkspacePage } from "../global";

export interface AgentRailSessions {
  workspaces: AgentWorkspace[];
  sessions: UnifiedSessionSummary[];
}

/** Read every page without changing the sidebar's selected Agent or native order. */
export async function loadAgentRailSessions(
  api: Pick<AgentApi, "listAgentWorkspaces" | "listAgentWorkspaceSessions">,
  agentType: AgentType,
  signal: AbortSignal,
): Promise<AgentRailSessions> {
  async function readPages<T>(read: (cursor: string | null) => Promise<WorkspacePage<T>>): Promise<T[]> {
    const rows: T[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      signal.throwIfAborted();
      const page = await read(cursor);
      signal.throwIfAborted();
      if (page.stale) throw new Error("会话列表待刷新，请重试");
      rows.push(...page.data);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) throw new Error("会话列表加载中断，请重试");
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return rows;
  }

  const workspaceRows = await readPages(cursor => api.listAgentWorkspaces(agentType, { cursor, limit: 200 }));
  const workspaces = [...new Map(workspaceRows.map(workspace => [workspace.workspaceId, workspace])).values()];
  const batches: UnifiedSessionSummary[][] = new Array(workspaces.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(4, workspaces.length) }, async () => {
    while (index < workspaces.length) {
      const position = index++;
      const workspace = workspaces[position];
      batches[position] = (await readPages(cursor => api.listAgentWorkspaceSessions(agentType, workspace.workspaceId, { cursor, limit: 200 })))
        .map(session => ({ ...session, projectId: workspace.workspaceId }));
    }
  }));
  const seen = new Set<string>();
  const sessions = batches.flat().filter(session => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
  return { workspaces, sessions };
}
