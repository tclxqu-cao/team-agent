import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep, win32 } from "node:path";
import {
  SQLiteProjectStore,
  type AgentEvent,
  type SessionHistoryQuery,
  type SessionMessagePayload,
  type ToolPermissionMode,
} from "@agent/core";
import {
  createNativeRuntimeBrokerClient,
  createNativeRuntimeBrokerHostRuntime,
  type BrokerRunEvent,
  type BrokerRunStart,
  type NativeRuntimeBrokerSnapshot,
  type NativeRuntimeController,
} from "../../desktop/main/agent-runtime/native-runtime-broker.js";
import { decodeUnifiedSessionId } from "../../desktop/main/agent-runtime/session-id.js";
import { RuntimeSessionError } from "../../desktop/main/agent-runtime/types.js";
import type {
  AgentType,
  AgentWorkspace,
  CreateRuntimeSessionOptions,
  ImportAgentWorkspaceResult,
  NativeReasoningEffort,
  RuntimeHealth,
  RuntimeModelInfo,
  RuntimeModelSelection,
  RuntimeQuestionAnswer,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
  WorkspacePage,
  WorkspaceQuery,
  WorkspaceSessionQuery,
} from "../../desktop/main/agent-runtime/types.js";
import type { SessionGoalState } from "@agent/core";
import { getServerBaseDir } from "./server-data-dir";

const globalWithService = globalThis as typeof globalThis & {
  __nativeRuntimeService?: NativeRuntimeService;
};

interface ProjectLike {
  id: string;
  description: string;
}

// The agentroam launchd job starts this server with PATH=/usr/bin:/bin:/usr/sbin:/sbin,
// which lacks the directories where codex/claude CLIs are installed — spawning them
// fails with ENOENT. Append the usual install locations (existing PATH wins).
function ensureNativeCliPath(): void {
  const candidates = [
    join(homedir(), ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];
  const current = (process.env.PATH ?? "").split(delimiter);
  const missing = candidates.filter((dir) => existsSync(dir) && !current.includes(dir));
  if (missing.length > 0) {
    process.env.PATH = [...current, ...missing].join(delimiter);
  }
}

/** Model/effort the UI pins onto one native run (per agent type, persisted client-side). */
export interface NativeRunOverrides {
  model?: RuntimeModelSelection;
  reasoningEffort?: NativeReasoningEffort;
}

/** Operations the web application needs from a native runtime host. */
export interface NativeRuntimePort {
  health(): Promise<RuntimeHealth[]>;
  listModels(agentType: Exclude<AgentType, "customer-agent">): Promise<RuntimeModelInfo[]>;
  listWorkspaces(agentType: Exclude<AgentType, "customer-agent">, query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
  listWorkspaceSessions(
    agentType: Exclude<AgentType, "customer-agent">,
    workspaceId: string,
    query?: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>>;
  importWorkspace?(
    agentType: Exclude<AgentType, "customer-agent">,
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult>;
  list(projectId?: string): Promise<UnifiedSessionSummary[]>;
  refresh(projectId?: string): Promise<UnifiedSessionSummary[]>;
  create(options: CreateRuntimeSessionOptions & { agentType: AgentType }): Promise<UnifiedSessionSummary>;
  fork(id: string): Promise<UnifiedSessionSummary>;
  delete(id: string): Promise<void>;
  get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
  getSessionWatchPath(id: string): Promise<string | null>;
  run(id: string, input: string, images?: string[], agentIds?: string[], agentName?: string): AsyncIterable<AgentEvent>;
  steer(id: string, input: string): Promise<boolean>;
  abort(id?: string): Promise<void>;
  answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
  startRun?(
    id: string,
    input: string,
    images?: string[],
    controller?: NativeRuntimeController,
    runOverrides?: NativeRunOverrides,
  ): Promise<BrokerRunStart>;
  subscribe?(
    id: string,
    afterSequence: number,
    listener: (event: BrokerRunEvent) => void,
  ): Promise<() => void>;
  snapshot?(id: string, afterSequence?: number): Promise<NativeRuntimeBrokerSnapshot>;
  setPermissionMode?(id: string, mode: ToolPermissionMode): Promise<UnifiedSessionSummary>;
  handoff?(id: string, controller: NativeRuntimeController): Promise<NativeRuntimeBrokerSnapshot>;
  getGoals?(id: string, controller?: NativeRuntimeController): Promise<SessionGoalState>;
  enqueueGoal?(
    id: string,
    objective: string,
    sourceMessageId?: string,
    controller?: NativeRuntimeController,
  ): Promise<{ state: SessionGoalState; started?: BrokerRunStart }>;
  reorderGoals?(id: string, orderedIds: readonly string[]): Promise<SessionGoalState>;
  cancelGoal?(id: string, goalId: string, controller?: NativeRuntimeController): Promise<SessionGoalState>;
  enqueueMessage?(
    id: string,
    input: { sourceMessageId: string; content: string; messagePayload?: SessionMessagePayload },
    controller?: NativeRuntimeController,
  ): Promise<{ state: SessionGoalState; started?: BrokerRunStart }>;
  reorderMessages?(id: string, orderedIds: readonly string[]): Promise<SessionGoalState>;
  updateMessage?(
    id: string,
    messageId: string,
    content: string,
    messagePayload?: SessionMessagePayload,
  ): Promise<SessionGoalState>;
  cancelMessage?(id: string, messageId: string): Promise<SessionGoalState>;
  steerMessage?(
    id: string,
    messageId: string,
  ): Promise<{ steered: boolean; state: SessionGoalState }>;
}

/**
 * Application service over the domain's UnifiedSessionService.
 *
 * Owns one piece of web-specific domain state: sessions this server created
 * that the native runtime cannot discover yet. Codex `thread/list` hides
 * threads until their first turn runs, so a freshly created session would
 * vanish from listings (and from the client's selection) until then. Pending
 * creations are projected into this client's project catalog, merged into
 * listings, and promoted out of the registry once real discovery returns them.
 */
export class NativeRuntimeService implements NativeRuntimePort {
  private readonly pendingCreations = new Map<string, UnifiedSessionSummary>();

  constructor(
    private readonly runtime: Pick<NativeRuntimePort, keyof NativeRuntimePort>,
    private readonly listProjects: () => Promise<ProjectLike[]> = async () => [],
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  health(): Promise<RuntimeHealth[]> {
    return this.runtime.health();
  }

  listModels(agentType: Exclude<AgentType, "customer-agent">): Promise<RuntimeModelInfo[]> {
    return this.runtime.listModels(agentType);
  }

  listWorkspaces(
    agentType: Exclude<AgentType, "customer-agent">,
    query?: WorkspaceQuery,
  ): Promise<WorkspacePage<AgentWorkspace>> {
    return this.runtime.listWorkspaces(agentType, query);
  }

  importWorkspace(
    agentType: Exclude<AgentType, "customer-agent">,
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult> {
    if (!this.runtime.importWorkspace) {
      throw new RuntimeSessionError("Native workspace import is unavailable", "OPERATION_NOT_SUPPORTED");
    }
    return this.runtime.importWorkspace(agentType, path, name);
  }

  async listWorkspaceSessions(
    agentType: Exclude<AgentType, "customer-agent">,
    workspaceId: string,
    query?: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const page = await this.runtime.listWorkspaceSessions(agentType, workspaceId, query);
    if (query?.cursor) return page;
    const discoveredIds = new Set(page.data.map((session) => session.id));
    const data = page.data.map((session) => {
      const pending = this.pendingCreations.get(session.id);
      if (!pending) return session;
      this.pendingCreations.delete(session.id);
      return mergePendingSessionContext(session, pending);
    });
    for (const pending of this.pendingCreations.values()) {
      if (
        pending.agentType === agentType
        && pending.projectId === workspaceId
        && !discoveredIds.has(pending.id)
      ) data.unshift(pending);
    }
    return { ...page, data };
  }

  async list(projectId?: string): Promise<UnifiedSessionSummary[]> {
    const [discovered, projects] = await Promise.all([
      this.runtime.list(),
      this.listProjects(),
    ]);
    return filterByProject(
      this.withPendingCreations(discovered).map((session) => associateLocalProject(session, projects, this.platform)),
      projectId,
    );
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    const [discovered, projects] = await Promise.all([
      this.runtime.refresh(),
      this.listProjects(),
    ]);
    return filterByProject(
      this.withPendingCreations(discovered).map((session) => associateLocalProject(session, projects, this.platform)),
      projectId,
    );
  }

  async create(options: CreateRuntimeSessionOptions & { agentType: AgentType }): Promise<UnifiedSessionSummary> {
    const associated = associateLocalProject(
      await this.runtime.create(options),
      await this.listProjects(),
      this.platform,
    );
    const created = options.projectId ? { ...associated, projectId: options.projectId } : associated;
    this.pendingCreations.set(created.id, created);
    return created;
  }

  async fork(id: string): Promise<UnifiedSessionSummary> {
    if (!isNativeSessionId(id)) {
      throw new RuntimeSessionError(
        "Customer Agent sessions do not support native forks",
        "OPERATION_NOT_SUPPORTED",
      );
    }
    const forked = associateLocalProject(
      await this.runtime.fork(id),
      await this.listProjects(),
      this.platform,
    );
    this.pendingCreations.set(forked.id, forked);
    return forked;
  }

  async delete(id: string): Promise<void> {
    await this.runtime.delete(id);
    this.pendingCreations.delete(id);
  }

  async get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail> {
    let detail: UnifiedSessionDetail;
    try {
      detail = await this.runtime.get(id, query);
    } catch (error) {
      const pending = this.pendingCreations.get(id);
      if (!pending) throw error;
      return query ? {
        ...pending,
        messages: [],
        events: [],
        history: { nextCursor: null, hasMore: false, pageSize: 0, totalItems: 0 },
      } : { ...pending, messages: [], events: [] };
    }
    return associateLocalProject(detail, await this.listProjects(), this.platform);
  }

  getSessionWatchPath(id: string): Promise<string | null> {
    return this.runtime.getSessionWatchPath(id);
  }

  run(id: string, input: string, images?: string[], agentIds?: string[], agentName?: string): AsyncIterable<AgentEvent> {
    return this.runtime.run(id, input, images, agentIds, agentName);
  }

  steer(id: string, input: string): Promise<boolean> {
    return this.runtime.steer(id, input);
  }

  abort(id?: string): Promise<void> {
    return this.runtime.abort(id);
  }

  answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    return this.runtime.answerQuestion(questionId, answer);
  }

  async startRun(
    id: string,
    input: string,
    images?: string[],
    controller: NativeRuntimeController = "web",
    runOverrides?: NativeRunOverrides,
  ): Promise<BrokerRunStart> {
    if (!this.runtime.startRun) {
      throw new RuntimeSessionError("Native runtime broker is unavailable", "RUNTIME_UNAVAILABLE");
    }
    return this.runtime.startRun(id, input, images, controller, runOverrides);
  }

  async subscribe(
    id: string,
    afterSequence: number,
    listener: (event: BrokerRunEvent) => void,
  ): Promise<() => void> {
    if (!this.runtime.subscribe) {
      throw new RuntimeSessionError("Native runtime broker is unavailable", "RUNTIME_UNAVAILABLE");
    }
    return this.runtime.subscribe(id, afterSequence, listener);
  }

  async snapshot(id: string, afterSequence = 0): Promise<NativeRuntimeBrokerSnapshot> {
    if (!this.runtime.snapshot) {
      throw new RuntimeSessionError("Native runtime broker is unavailable", "RUNTIME_UNAVAILABLE");
    }
    return this.runtime.snapshot(id, afterSequence);
  }

  async setPermissionMode(id: string, mode: ToolPermissionMode): Promise<UnifiedSessionSummary> {
    if (!this.runtime.setPermissionMode) {
      throw new RuntimeSessionError("Native runtime broker is unavailable", "RUNTIME_UNAVAILABLE");
    }
    return this.runtime.setPermissionMode(id, mode);
  }

  async handoff(id: string, controller: NativeRuntimeController): Promise<NativeRuntimeBrokerSnapshot> {
    if (!this.runtime.handoff) {
      throw new RuntimeSessionError("Native runtime broker is unavailable", "RUNTIME_UNAVAILABLE");
    }
    return this.runtime.handoff(id, controller);
  }

  async getGoals(id: string, controller: NativeRuntimeController = "web"): Promise<SessionGoalState> {
    if (!this.runtime.getGoals) throw new RuntimeSessionError("Goal mode is unavailable", "OPERATION_NOT_SUPPORTED");
    return this.runtime.getGoals(id, controller);
  }

  async enqueueGoal(
    id: string,
    objective: string,
    sourceMessageId?: string,
    controller: NativeRuntimeController = "web",
  ): Promise<{ state: SessionGoalState; started?: BrokerRunStart }> {
    if (!this.runtime.enqueueGoal) throw new RuntimeSessionError("Goal mode is unavailable", "OPERATION_NOT_SUPPORTED");
    return this.runtime.enqueueGoal(id, objective, sourceMessageId, controller);
  }

  async reorderGoals(id: string, orderedIds: readonly string[]): Promise<SessionGoalState> {
    if (!this.runtime.reorderGoals) throw new RuntimeSessionError("Goal mode is unavailable", "OPERATION_NOT_SUPPORTED");
    return this.runtime.reorderGoals(id, orderedIds);
  }

  async cancelGoal(id: string, goalId: string): Promise<SessionGoalState> {
    if (!this.runtime.cancelGoal) throw new RuntimeSessionError("Goal mode is unavailable", "OPERATION_NOT_SUPPORTED");
    return this.runtime.cancelGoal(id, goalId, "web");
  }

  async enqueueMessage(
    id: string,
    input: { sourceMessageId: string; content: string; messagePayload?: SessionMessagePayload },
    controller: NativeRuntimeController = "web",
  ): Promise<{ state: SessionGoalState; started?: BrokerRunStart }> {
    if (!this.runtime.enqueueMessage) {
      throw new RuntimeSessionError("Message queue is unavailable", "OPERATION_NOT_SUPPORTED");
    }
    return this.runtime.enqueueMessage(id, input, controller);
  }

  async reorderMessages(id: string, orderedIds: readonly string[]): Promise<SessionGoalState> {
    if (!this.runtime.reorderMessages) {
      throw new RuntimeSessionError("Message queue is unavailable", "OPERATION_NOT_SUPPORTED");
    }
    return this.runtime.reorderMessages(id, orderedIds);
  }

  async updateMessage(
    id: string,
    messageId: string,
    content: string,
    messagePayload?: SessionMessagePayload,
  ): Promise<SessionGoalState> {
    if (!this.runtime.updateMessage) {
      throw new RuntimeSessionError("Message queue is unavailable", "OPERATION_NOT_SUPPORTED");
    }
    return this.runtime.updateMessage(id, messageId, content, messagePayload);
  }

  async cancelMessage(id: string, messageId: string): Promise<SessionGoalState> {
    if (!this.runtime.cancelMessage) {
      throw new RuntimeSessionError("Message queue is unavailable", "OPERATION_NOT_SUPPORTED");
    }
    return this.runtime.cancelMessage(id, messageId);
  }

  async steerMessage(
    id: string,
    messageId: string,
  ): Promise<{ steered: boolean; state: SessionGoalState }> {
    if (!this.runtime.steerMessage) {
      throw new RuntimeSessionError("Message queue is unavailable", "OPERATION_NOT_SUPPORTED");
    }
    return this.runtime.steerMessage(id, messageId);
  }

  private withPendingCreations(
    discovered: UnifiedSessionSummary[],
  ): UnifiedSessionSummary[] {
    const discoveredIds = new Set<string>();
    const merged = discovered.map((session) => {
      discoveredIds.add(session.id);
      const pending = this.pendingCreations.get(session.id);
      this.pendingCreations.delete(session.id);
      return pending ? mergePendingSessionContext(session, pending) : session;
    });
    for (const pending of this.pendingCreations.values()) {
      if (!discoveredIds.has(pending.id)) merged.push(pending);
    }
    return merged.sort((left, right) => right.updated.localeCompare(left.updated));
  }
}

function mergePendingSessionContext(
  discovered: UnifiedSessionSummary,
  pending: UnifiedSessionSummary,
): UnifiedSessionSummary {
  return {
    ...discovered,
    cwd: discovered.cwd || pending.cwd,
    projectId: discovered.projectId ?? pending.projectId,
  };
}

/**
 * Server-side native runtime service hosting only the external native
 * runtimes (Codex / Claude Code). The customer-agent runtime is owned by
 * agent-host + SQLite and is never registered here, so native session IDs
 * are the only ones this service ever sees.
 *
 * The globalThis guard keeps dev HMR from spawning duplicate codex
 * app-server processes across module reloads.
 */
export function getNativeRuntimeService(): NativeRuntimeService {
  if (!globalWithService.__nativeRuntimeService) {
    ensureNativeCliPath();
    const projectStore = new SQLiteProjectStore(getServerBaseDir());
    globalWithService.__nativeRuntimeService = new NativeRuntimeService(
      createNativeRuntimeBrokerClient({
        runtimeFactory: (callbacks) => createNativeRuntimeBrokerHostRuntime(
          process.env.AGENT_CODEX_BIN?.trim() || "codex",
          callbacks,
          process.env.AGENT_OPENCODE_BIN?.trim() || "opencode",
        ),
      }),
      () => projectStore.list(),
    );
  }
  return globalWithService.__nativeRuntimeService;
}

export function associateLocalProject<T extends UnifiedSessionSummary>(
  session: T,
  projects: ProjectLike[],
  platform: NodeJS.Platform = process.platform,
): T {
  const { projectId: _foreignProjectId, ...unassociated } = session;
  if (!session.cwd) return unassociated as T;
  const cwd = normalizeProjectPath(session.cwd, platform);
  const separator = platform === "win32" ? win32.sep : sep;
  const match = projects
    .filter((project) => project.description)
    .map((project) => ({ project, path: normalizeProjectPath(project.description, platform) }))
    .filter(({ path }) => cwd === path || cwd.startsWith(`${path}${separator}`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  return (match ? { ...unassociated, projectId: match.project.id } : unassociated) as T;
}

export function normalizeProjectPath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return resolve(value);
  const normalized = win32.resolve(value);
  const root = win32.parse(normalized).root;
  const withoutTrailingSeparators = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, "")
    : normalized;
  return withoutTrailingSeparators.toLowerCase();
}

function filterByProject<T extends UnifiedSessionSummary>(sessions: T[], projectId?: string): T[] {
  return projectId === undefined
    ? sessions
    : sessions.filter((session) => session.projectId === projectId);
}

/** True for unified IDs that belong to an external native runtime. */
export function isNativeSessionId(id: string): boolean {
  try {
    return decodeUnifiedSessionId(id).agentType !== "customer-agent";
  } catch {
    return false;
  }
}

export function runtimeErrorStatus(err: unknown): number {
  if (err instanceof RuntimeSessionError) {
    switch (err.code) {
      case "SESSION_NOT_FOUND":
        return 404;
      case "SESSION_OCCUPIED":
      case "SESSION_ALREADY_RUNNING":
        return 409;
      case "RUNTIME_UNAVAILABLE":
        return 503;
      case "OPERATION_NOT_SUPPORTED":
        return 405;
      case "APPROVAL_EXPIRED":
      case "CODEX_SESSION_VERSION_INCOMPATIBLE":
        return 409;
      default:
        return 400;
    }
  }
  return 500;
}
