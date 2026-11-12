import type { AgentType, SessionCompatibility } from "../global";

/** Sidebar view-model for one logical engine thread (T3-style AppThread). */
export interface EngineThreadSummary {
  threadKey: string;
  title: string;
  originSessionId: string;
  currentSessionId: string;
  currentAgentType: string;
  created: string;
  updated: string;
  members: Array<{
    id: string;
    agentType?: AgentType;
    title?: string;
    status?: string;
    cwd?: string;
    compatibility?: SessionCompatibility;
  }>;
}

export interface EngineThreadEntry {
  threadKey: string;
  originSessionId: string;
  members: Array<{ id: string; agentType?: AgentType; title?: string; status?: string; cwd?: string }>;
}

export type EngineThreadIndex = Map<string, EngineThreadEntry>;

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
  const index: EngineThreadIndex = new Map();
  const response = await gatewayGet("/api/engine-threads");
  if (!response || response.status !== 200) return index;
  let body: { threads?: EngineThreadSummary[] } = {};
  try { body = JSON.parse(response.body || "{}") as typeof body; } catch { return index; }
  for (const thread of body.threads ?? []) {
    const entry: EngineThreadEntry = {
      threadKey: thread.threadKey,
      originSessionId: thread.originSessionId,
      members: thread.members ?? [],
    };
    for (const member of thread.members ?? []) {
      index.set(member.id, entry);
    }
  }
  return index;
}
