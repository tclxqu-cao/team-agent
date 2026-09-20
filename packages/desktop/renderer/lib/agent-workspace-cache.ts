import type {
  AgentType,
  AgentWorkspace,
  UnifiedSessionSummary,
  WorkspacePage,
} from "../global";

export const AGENT_WORKSPACE_CACHE_KEY = "agentroam.agent-workspaces.v2";
export const AGENT_WORKSPACE_CACHE_VERSION = 2;
export const AGENT_TYPES: AgentType[] = ["customer-agent", "codex", "claude-code", "opencode"];

export interface CachedWorkspaceSessions {
  data: UnifiedSessionSummary[];
  nextCursor: string | null;
  loaded: boolean;
}

export interface AgentWorkspacePartition {
  workspaces: AgentWorkspace[];
  nextCursor: string | null;
  watermark: string | null;
  expandedWorkspaceIds: string[];
  selectedWorkspaceId: string | null;
  selectedSessionId: string | null;
  sidebarScrollTop: number;
  sessions: Record<string, CachedWorkspaceSessions>;
}

export interface AgentWorkspaceCache {
  version: 2;
  activeAgent: AgentType;
  agents: Partial<Record<AgentType, AgentWorkspacePartition>>;
}

export function emptyAgentWorkspaceCache(): AgentWorkspaceCache {
  return { version: 2, activeAgent: "customer-agent", agents: {} };
}

export function emptyAgentWorkspacePartition(): AgentWorkspacePartition {
  return {
    workspaces: [],
    nextCursor: null,
    watermark: null,
    expandedWorkspaceIds: [],
    selectedWorkspaceId: null,
    selectedSessionId: null,
    sidebarScrollTop: 0,
    sessions: {},
  };
}

/**
 * Cold-boot cache read. Each Agent's selected session and sidebar state persist
 * together so a refreshed page can restore the last active conversation.
 * Subsequent workspace and session refreshes clear selections that no longer
 * exist.
 */
export function readAgentWorkspaceCache(storage: Pick<Storage, "getItem"> = localStorage): AgentWorkspaceCache {
  try {
    const value = JSON.parse(storage.getItem(AGENT_WORKSPACE_CACHE_KEY) ?? "null") as unknown;
    if (!isRecord(value) || value.version !== AGENT_WORKSPACE_CACHE_VERSION) return emptyAgentWorkspaceCache();
    const activeAgent = isAgentType(value.activeAgent) ? value.activeAgent : "customer-agent";
    const rawAgents = isRecord(value.agents) ? value.agents : {};
    const agents: AgentWorkspaceCache["agents"] = {};
    for (const agentType of AGENT_TYPES) {
      const partition = parsePartition(rawAgents[agentType], agentType);
      if (!partition) continue;
      agents[agentType] = partition;
    }
    return { version: 2, activeAgent, agents };
  } catch {
    return emptyAgentWorkspaceCache();
  }
}

export function writeAgentWorkspaceCache(
  cache: AgentWorkspaceCache,
  storage: Pick<Storage, "setItem"> = localStorage,
): void {
  try {
    storage.setItem(AGENT_WORKSPACE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Browsing remains usable when persistent storage is full or disabled.
  }
}

export function reconcileWorkspacePage(
  current: readonly AgentWorkspace[],
  page: WorkspacePage<AgentWorkspace>,
  replace: boolean,
): AgentWorkspace[] {
  const pageIds = new Set(page.data.map((workspace) => workspace.workspaceId));
  const source = replace
    ? page.nextCursor
      ? [...page.data, ...current.filter((workspace) => !pageIds.has(workspace.workspaceId))]
      : page.data
    : [...current, ...page.data];
  const seen = new Set<string>();
  return source.filter((workspace) => {
    if (seen.has(workspace.workspaceId)) return false;
    seen.add(workspace.workspaceId);
    return true;
  });
}

export function reconcileSessionPage(
  current: readonly UnifiedSessionSummary[],
  page: WorkspacePage<UnifiedSessionSummary>,
  replace: boolean,
): UnifiedSessionSummary[] {
  const freshIds = new Set(page.data.map((session) => session.id));
  const source = replace
    ? page.nextCursor
      ? [...page.data, ...current.filter((session) => !freshIds.has(session.id))]
      : page.data
    : [...current, ...page.data];
  const seen = new Set<string>();
  return source.filter((session) => {
    if (seen.has(session.id)) return false;
    seen.add(session.id);
    return true;
  });
}

export function preservePendingNativeSession(
  refreshed: readonly UnifiedSessionSummary[],
  pendingSession?: UnifiedSessionSummary,
): UnifiedSessionSummary[] {
  if (!pendingSession || refreshed.some((session) => session.id === pendingSession.id)) {
    return [...refreshed];
  }
  return [pendingSession, ...refreshed];
}

function parsePartition(value: unknown, agentType: AgentType): AgentWorkspacePartition | null {
  if (!isRecord(value)) return null;
  const workspaces = Array.isArray(value.workspaces)
    ? value.workspaces.filter((workspace): workspace is AgentWorkspace => (
      isRecord(workspace)
      && workspace.agentType === agentType
      && typeof workspace.workspaceId === "string"
      && typeof workspace.name === "string"
      && Array.isArray(workspace.roots)
      && workspace.roots.every((root) => typeof root === "string")
      && typeof workspace.order === "number"
      && (workspace.canCreateSession === undefined || typeof workspace.canCreateSession === "boolean")
    ))
    : [];
  const sessions: Record<string, CachedWorkspaceSessions> = {};
  if (isRecord(value.sessions)) {
    for (const [workspaceId, raw] of Object.entries(value.sessions)) {
      if (!isRecord(raw) || !Array.isArray(raw.data)) continue;
      sessions[workspaceId] = {
        data: raw.data.filter((session): session is UnifiedSessionSummary => (
          isRecord(session) && session.agentType === agentType && typeof session.id === "string"
        )),
        nextCursor: typeof raw.nextCursor === "string" ? raw.nextCursor : null,
        loaded: raw.loaded === true,
      };
    }
  }
  return {
    workspaces,
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
    watermark: typeof value.watermark === "string" ? value.watermark : null,
    expandedWorkspaceIds: Array.isArray(value.expandedWorkspaceIds)
      ? value.expandedWorkspaceIds.filter((id): id is string => typeof id === "string")
      : [],
    selectedWorkspaceId: typeof value.selectedWorkspaceId === "string" ? value.selectedWorkspaceId : null,
    selectedSessionId: typeof value.selectedSessionId === "string" ? value.selectedSessionId : null,
    sidebarScrollTop: typeof value.sidebarScrollTop === "number" && value.sidebarScrollTop >= 0
      ? value.sidebarScrollTop
      : 0,
    sessions,
  };
}

function isAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && AGENT_TYPES.includes(value as AgentType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
