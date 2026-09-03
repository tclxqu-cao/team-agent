import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import {
  SQLiteProjectStore,
  type AgentEvent,
  type SessionHistoryQuery,
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
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
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

/** Operations the web application needs from a native runtime host. */
export interface NativeRuntimePort {
  health(): Promise<RuntimeHealth[]>;
  list(projectId?: string): Promise<UnifiedSessionSummary[]>;
  refresh(projectId?: string): Promise<UnifiedSessionSummary[]>;
  create(options: CreateRuntimeSessionOptions & { agentType: AgentType }): Promise<UnifiedSessionSummary>;
  fork(id: string): Promise<UnifiedSessionSummary>;
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
  ) {}

  health(): Promise<RuntimeHealth[]> {
    return this.runtime.health();
  }

  async list(projectId?: string): Promise<UnifiedSessionSummary[]> {
    const [discovered, projects] = await Promise.all([
      this.runtime.list(),
      this.listProjects(),
    ]);
    return filterByProject(
      this.withPendingCreations(discovered.map((session) => associateLocalProject(session, projects))),
      projectId,
    );
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    const [discovered, projects] = await Promise.all([
      this.runtime.refresh(),
      this.listProjects(),
    ]);
    return filterByProject(
      this.withPendingCreations(discovered.map((session) => associateLocalProject(session, projects))),
      projectId,
    );
  }

  async create(options: CreateRuntimeSessionOptions & { agentType: AgentType }): Promise<UnifiedSessionSummary> {
    const created = associateLocalProject(
      await this.runtime.create(options),
      await this.listProjects(),
    );
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
    );
    this.pendingCreations.set(forked.id, forked);
    return forked;
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
    return associateLocalProject(detail, await this.listProjects());
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
  ): Promise<BrokerRunStart> {
    if (!this.runtime.startRun) {
      throw new RuntimeSessionError("Native runtime broker is unavailable", "RUNTIME_UNAVAILABLE");
    }
    return this.runtime.startRun(id, input, images, controller);
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

  private withPendingCreations(
    discovered: UnifiedSessionSummary[],
  ): UnifiedSessionSummary[] {
    const discoveredIds = new Set<string>();
    for (const session of discovered) {
      discoveredIds.add(session.id);
      this.pendingCreations.delete(session.id);
    }
    const merged = [...discovered];
    for (const pending of this.pendingCreations.values()) {
      if (!discoveredIds.has(pending.id)) merged.push(pending);
    }
    return merged.sort((left, right) => right.updated.localeCompare(left.updated));
  }
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
        ),
      }),
      () => projectStore.list(),
    );
  }
  return globalWithService.__nativeRuntimeService;
}

function associateLocalProject<T extends UnifiedSessionSummary>(
  session: T,
  projects: ProjectLike[],
): T {
  const { projectId: _foreignProjectId, ...unassociated } = session;
  if (!session.cwd) return unassociated as T;
  const cwd = resolve(session.cwd);
  const match = projects
    .filter((project) => project.description)
    .map((project) => ({ project, path: resolve(project.description) }))
    .filter(({ path }) => cwd === path || cwd.startsWith(`${path}${sep}`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  return (match ? { ...unassociated, projectId: match.project.id } : unassociated) as T;
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
        return 409;
      case "RUNTIME_UNAVAILABLE":
        return 503;
      case "OPERATION_NOT_SUPPORTED":
        return 405;
      case "APPROVAL_EXPIRED":
        return 409;
      default:
        return 400;
    }
  }
  return 500;
}
