import type { AgentType, UnifiedSessionSummary } from "../global";

/** Sidebar view-model for one logical engine thread (T3-style AppThread). */
export interface EngineThreadSummary {
  threadKey: string;
  title: string;
  originSessionId: string;
  currentSessionId: string;
  currentAgentType: AgentType;
  created: string;
  updated: string;
  members: Array<Partial<UnifiedSessionSummary> & { id: string }>;
}

export type EngineThreadEntry = EngineThreadSummary;

export type EngineThreadIndex = Map<string, EngineThreadEntry>;

let pendingIndex: Promise<EngineThreadIndex> | null = null;

async function gatewayGet(path: string): Promise<{ status: number; body: string } | null> {
  const shared = typeof window !== "undefined" ? window.sharedServiceApi : undefined;
  if (shared?.request) {
    try { return await shared.request(path, "GET"); } catch { return null; }
  }
  try {
    const response = await fetch(path, { credentials: "same-origin" });
    return { status: response.status, body: await response.text() };
  } catch { return null; }
}

export async function fetchEngineThreadIndex(): Promise<EngineThreadIndex> {
  if (pendingIndex) return pendingIndex;
  pendingIndex = loadEngineThreadIndex().finally(() => {
    pendingIndex = null;
  });
  return pendingIndex;
}

async function loadEngineThreadIndex(): Promise<EngineThreadIndex> {
  const index: EngineThreadIndex = new Map();
  const response = await gatewayGet("/api/engine-threads");
  if (!response || response.status !== 200) throw new Error("无法刷新切换会话索引");
  let body: { threads?: EngineThreadSummary[] } = {};
  body = JSON.parse(response.body || "{}") as typeof body;
  for (const thread of body.threads ?? []) {
    const entry: EngineThreadEntry = { ...thread, members: thread.members ?? [] };
    for (const member of thread.members ?? []) {
      index.set(member.id, entry);
    }
  }
  return index;
}

export function activeThreadSession(entry: EngineThreadEntry): UnifiedSessionSummary | undefined {
  const member = entry.members.find((session) => session.id === entry.currentSessionId);
  if (!member?.agentType || !member.status || !member.occupancy || member.canResume === undefined) return;
  return { ...member, title: entry.title || member.title } as UnifiedSessionSummary;
}

/** Resolve a stale saved selection without blocking ordinary history loading. */
export function historyThreadRedirect(detail: unknown, requestedId: string): UnifiedSessionSummary | undefined {
  const value = detail as (UnifiedSessionSummary & { threadKey?: string; activeSessionId?: string }) | null;
  return value?.threadKey && value.id !== requestedId && value.activeSessionId === value.id ? value : undefined;
}

/** One logical conversation; engine refs are not synthetic child conversations. */
export function foldEngineThreadSessions<T extends { id: string }>(sessions: T[], index: EngineThreadIndex | null): T[] {
  if (!index?.size) return sessions;
  const seen = new Set<string>();
  return sessions.flatMap((session) => {
    const entry = index.get(session.id);
    if (!entry) return [session];
    if (seen.has(entry.threadKey)) return [];
    seen.add(entry.threadKey);
    const active = activeThreadSession(entry);
    return [{ ...session, ...(active ?? {}) } as T];
  });
}
