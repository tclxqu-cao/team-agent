import type { AgentWorkspacePartition } from "./agent-workspace-cache";

interface SessionDeletionTarget {
  agentType: string;
  title: string;
}

interface SessionCollectionItem {
  id: string;
  parentSessionId?: string;
}

export function sessionDeletionConfirmation(session: SessionDeletionTarget): string {
  if (session.agentType === "customer-agent") {
    return `确定永久删除会话“${session.title}”吗？此操作不可恢复。`;
  }
  if (session.agentType === "codex") {
    return `确定归档 Codex 会话“${session.title}”并从 AgentRoam 中移除吗？可在 Codex 的已归档会话中恢复。`;
  }
  return `确定从 AgentRoam 中移除会话“${session.title}”吗？原生客户端中的历史记录会保留。`;
}

export function removeSessionIdsFromWorkspacePartition(
  partition: AgentWorkspacePartition,
  removedIds: readonly string[],
): AgentWorkspacePartition {
  const removed = new Set(removedIds);
  return {
    ...partition,
    selectedSessionId: partition.selectedSessionId && removed.has(partition.selectedSessionId)
      ? null
      : partition.selectedSessionId,
    sessions: Object.fromEntries(Object.entries(partition.sessions).map(([id, page]) => [
      id,
      { ...page, data: page.data.filter((session) => !removed.has(session.id)) },
    ])),
  };
}

export function removeSessionIdsFromIndex<T extends SessionCollectionItem>(
  index: Record<string, T[]>,
  removedIds: readonly string[],
): Record<string, T[]> {
  const removed = new Set(removedIds);
  let changed = false;
  const next = Object.fromEntries(Object.entries(index).map(([key, sessions]) => {
    const filtered = sessions.filter((session) => !removed.has(session.id));
    if (filtered.length !== sessions.length) changed = true;
    return [key, filtered.length === sessions.length ? sessions : filtered];
  }));
  return changed ? next : index;
}

export function removeSessionFromCollections<T extends SessionCollectionItem>(
  sessionsByProject: Record<string, T[]>,
  childSessionsByParent: Record<string, T[]>,
  otherLocalSessions: T[],
  sessionId: string,
): {
  sessionsByProject: Record<string, T[]>;
  childSessionsByParent: Record<string, T[]>;
  otherLocalSessions: T[];
  removedIds: string[];
} {
  const removedIds = [
    sessionId,
    ...(childSessionsByParent[sessionId] ?? []).map((session) => session.id),
  ];
  const removed = new Set(removedIds);
  const nextChildren = Object.fromEntries(Object.entries(childSessionsByParent).flatMap(([parentId, sessions]) => {
    if (removed.has(parentId)) return [];
    const filtered = sessions.filter((session) => !removed.has(session.id));
    return [[parentId, filtered.length === sessions.length ? sessions : filtered]];
  })) as Record<string, T[]>;

  return {
    sessionsByProject: removeSessionIdsFromIndex(sessionsByProject, removedIds),
    childSessionsByParent: nextChildren,
    otherLocalSessions: otherLocalSessions.filter((session) => !removed.has(session.id)),
    removedIds,
  };
}
