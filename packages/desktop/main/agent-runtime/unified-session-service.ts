import { resolve, sep } from "node:path";
import {
  SessionQueryIndexCache,
  paginateSessionHistory,
  type AgentEvent,
  type SessionHistoryQuery,
  type SessionQueryIndex,
} from "@agent/core";
import { decodeUnifiedSessionId } from "./session-id.js";
import { AgentWorkspaceIndexService } from "./agent-workspace-index.js";
import type { CodexSessionCompatibilityService } from "./codex-session-compatibility.js";
import type {
  AgentRuntimeAdapter,
  AgentType,
  AgentWorkspace,
  ImportedAgentWorkspaceRepository,
  ImportAgentWorkspaceResult,
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeModelInfo,
  RuntimeQuestionAnswer,
  RuntimeRunOptions,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
  WorkspacePage,
  WorkspaceQuery,
  WorkspaceSessionQuery,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";

interface ProjectLike {
  id: string;
  description: string;
}

export class UnifiedSessionService {
  private readonly adapters = new Map<AgentType, AgentRuntimeAdapter>();
  private readonly workspaceIndex: AgentWorkspaceIndexService;
  private readonly activeSessionIds = new Set<string>();
  private healthCache: RuntimeHealth[] = [];
  private discoveryPromise: Promise<UnifiedSessionSummary[]> | null = null;
  private readonly detailCache = new Map<string, UnifiedSessionDetail>();
  private readonly queryIndexCache = new SessionQueryIndexCache();

  constructor(
    adapters: AgentRuntimeAdapter[],
    private readonly listProjects: () => Promise<ProjectLike[]>,
    importedWorkspaces?: ImportedAgentWorkspaceRepository,
    private readonly codexCompatibility?: CodexSessionCompatibilityService,
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.agentType, adapter);
    this.workspaceIndex = new AgentWorkspaceIndexService(
      adapters,
      importedWorkspaces,
      process.platform,
      codexCompatibility ? (primary) => codexCompatibility.supplement(primary) : undefined,
    );
  }

  listWorkspaces(agentType: AgentType, query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>> {
    return this.workspaceIndex.listWorkspaces(agentType, query);
  }

  listWorkspaceSessions(
    agentType: AgentType,
    workspaceId: string,
    query?: WorkspaceSessionQuery,
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    return this.workspaceIndex.listWorkspaceSessions(agentType, workspaceId, query);
  }

  importWorkspace(
    agentType: AgentType,
    path: string,
    name?: string,
  ): Promise<ImportAgentWorkspaceResult> {
    return this.workspaceIndex.importWorkspace(agentType, path, name);
  }

  async health(): Promise<RuntimeHealth[]> {
    const results = await Promise.all([...this.adapters.values()].map(async (adapter) => {
      try {
        return await adapter.health();
      } catch (error) {
        return {
          agentType: adapter.agentType,
          available: false,
          label: adapter.agentType,
          error: error instanceof Error ? error.message : String(error),
        } satisfies RuntimeHealth;
      }
    }));
    this.healthCache = results;
    return results;
  }

  getCachedHealth(): RuntimeHealth[] {
    return this.healthCache;
  }

  /** Models offered by one runtime's own connection (codex account, opencode providers, …). */
  async listModels(agentType: AgentType): Promise<RuntimeModelInfo[]> {
    const adapter = this.adapters.get(agentType);
    if (!adapter || !adapter.listModels) {
      throw new RuntimeSessionError(
        `Runtime ${agentType} does not expose a model list`,
        "OPERATION_NOT_SUPPORTED",
      );
    }
    return adapter.listModels();
  }

  async list(projectId?: string): Promise<UnifiedSessionSummary[]> {
    const sessions = await this.discoverAll();
    return sessions.filter((session) => projectId === undefined || session.projectId === projectId);
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    this.discoveryPromise = null;
    this.detailCache.clear();
    this.queryIndexCache.clear();
    return this.list(projectId);
  }

  invalidate(id: string): void {
    this.detailCache.delete(id);
    this.queryIndexCache.invalidate(id);
    this.discoveryPromise = null;
    const decoded = decodeUnifiedSessionId(id);
    this.workspaceIndex.invalidate(decoded.agentType);
  }

  invalidateCodexCompatibility(): void {
    this.discoveryPromise = null;
    this.workspaceIndex.invalidate("codex");
  }

  private async discoverAll(): Promise<UnifiedSessionSummary[]> {
    if (this.discoveryPromise) return this.discoveryPromise;
    this.discoveryPromise = this.performDiscovery().catch((error) => {
      this.discoveryPromise = null;
      throw error;
    });
    return this.discoveryPromise;
  }

  private async performDiscovery(): Promise<UnifiedSessionSummary[]> {
    const projects = await this.listProjects();
    const batches = await Promise.all([...this.adapters.values()].map(async (adapter) => {
      try {
        const primary = await adapter.discoverSessions();
        const sessions = adapter.agentType === "codex" && this.codexCompatibility
          ? this.codexCompatibility.supplement(primary)
          : primary;
        return sessions.map((session) => associateProject(session, projects));
      } catch (error) {
        this.recordFailure(adapter.agentType, error);
        return [];
      }
    }));
    return batches
      .flat()
      .sort((left, right) => right.updated.localeCompare(left.updated));
  }

  async listChildren(parentId: string): Promise<UnifiedSessionSummary[]> {
    const all = await this.list();
    return all.filter((session) => session.parentSessionId === parentId);
  }

  async get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail> {
    if (query) {
      const paged = await this.getPagedDetail(id, query);
      if (paged) return paged;
    }
    const associated = await this.getUnpaginated(id, shouldReuseSessionDetailCache(query));
    this.queryIndexCache.getOrCreate(id, associated.messages);
    if (!query) return associated;
    return {
      ...associated,
      ...paginateSessionHistory(associated.messages, associated.events, query),
    };
  }

  /**
   * Adapter-native windowed history (e.g. Codex turn paging). The adapter owns
   * ONE self-consistent ordinal space for the session — latest/before/after/
   * anchor pages and the query index all come from it, so cursors, historyIds
   * and anchors cross-reference correctly. The hybrid detail is deliberately
   * NOT stored in the full detail cache: tool bodies outside the window are
   * absent, and the legacy cache is keyed by a different ordinal space.
   */
  async getPagedDetail(
    id: string,
    query: SessionHistoryQuery,
  ): Promise<UnifiedSessionDetail | null> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    if (!adapter.getSessionPaged) return null;
    if (adapter.agentType === "codex" && this.codexCompatibility?.isSupplemental(nativeSessionId)) return null;
    try {
      const detail = await adapter.getSessionPaged(nativeSessionId, query);
      const projects = await this.listProjects();
      return associateProject(detail, projects);
    } catch (error) {
      if (error instanceof RuntimeSessionError && error.code === "OPERATION_NOT_SUPPORTED") return null;
      throw error;
    }
  }

  async getQueryIndex(id: string): Promise<SessionQueryIndex> {
    const native = await this.getQueryIndexNative(id).catch(() => null);
    if (native) return native;
    const detail = await this.getUnpaginated(id, true);
    return this.queryIndexCache.getOrCreate(id, detail.messages);
  }

  async getQueryIndexNative(id: string): Promise<SessionQueryIndex | null> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    if (!adapter.getQueryIndex) return null;
    if (adapter.agentType === "codex" && this.codexCompatibility?.isSupplemental(nativeSessionId)) return null;
    return adapter.getQueryIndex(nativeSessionId);
  }

  async getUnpaginated(id: string, preferCache = false): Promise<UnifiedSessionDetail> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    const cached = preferCache ? this.detailCache.get(id) : undefined;
    const detail = cached ?? await (
      adapter.agentType === "codex" && this.codexCompatibility?.isSupplemental(nativeSessionId)
        ? this.codexCompatibility.readSupplemental(nativeSessionId)
        : adapter.getSession(nativeSessionId)
    );
    this.cacheDetail(id, detail);
    const projects = await this.listProjects();
    return associateProject(detail, projects);
  }

  async getSessionWatchPath(id: string): Promise<string | null> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    return adapter.getSessionWatchPath?.(nativeSessionId) ?? null;
  }

  async create(
    options: CreateRuntimeSessionOptions & { agentType: AgentType },
  ): Promise<UnifiedSessionSummary> {
    const adapter = this.adapters.get(options.agentType);
    if (!adapter) {
      throw new RuntimeSessionError(`Runtime is unavailable: ${options.agentType}`, "RUNTIME_UNAVAILABLE");
    }
    if (options.agentType !== "customer-agent" && !options.cwd) {
      throw new RuntimeSessionError("A project working directory is required", "INVALID_SESSION_ID");
    }
    const created = await adapter.create(options);
    this.discoveryPromise = null;
    return created;
  }

  restoreDrafts(summaries: readonly UnifiedSessionSummary[]): void {
    for (const summary of summaries) {
      this.adapters.get(summary.agentType)?.restoreDraft?.(summary);
    }
    this.discoveryPromise = null;
  }

  async fork(id: string): Promise<UnifiedSessionSummary> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    if (!adapter.fork) {
      throw new RuntimeSessionError(
        "This runtime does not support session forks",
        "OPERATION_NOT_SUPPORTED",
      );
    }
    const forked = await adapter.fork(nativeSessionId);
    this.discoveryPromise = null;
    return forked;
  }

  async *run(
    id: string,
    input: string,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
    options?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    const detail = await adapter.getSession(nativeSessionId);
    // Codex occupancy is advisory: the app-server writer lock authoritatively
    // rejects a second writer, so a stale "owned-externally" marker must not
    // block an attempted takeover. Other runtimes cannot report a reliable
    // conflict and keep the upfront refusal.
    const occupancyAdvisory = adapter.agentType === "codex";
    if (!occupancyAdvisory && (!detail.canResume || detail.occupancy === "owned-externally")) {
      throw new RuntimeSessionError("Session is currently owned by another client", "SESSION_OCCUPIED");
    }
    if (this.activeSessionIds.has(id)) {
      throw new RuntimeSessionError("Session is already running", "SESSION_ALREADY_RUNNING");
    }
    this.activeSessionIds.add(id);
    this.detailCache.delete(id);
    try {
      // Keep the legacy five-argument adapter invocation intact when no broker
      // metadata is present. Native broker-owned turns use the sixth argument.
      yield* options === undefined
        ? adapter.run(nativeSessionId, input, images, agentIds, agentName)
        : adapter.run(nativeSessionId, input, images, agentIds, agentName, options);
    } finally {
      this.activeSessionIds.delete(id);
      this.detailCache.delete(id);
      this.discoveryPromise = null;
    }
  }

  async abort(id?: string): Promise<void> {
    if (id) {
      const { adapter, nativeSessionId } = this.resolveAdapter(id);
      await adapter.abort(nativeSessionId);
      return;
    }
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.abort("")));
  }

  async steer(id: string, input: string): Promise<boolean> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    if (!adapter.steer) {
      throw new RuntimeSessionError(
        "This runtime does not support mid-turn steering",
        "OPERATION_NOT_SUPPORTED",
      );
    }
    if (!this.activeSessionIds.has(id)) return false;
    return adapter.steer(nativeSessionId, input);
  }

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    for (const adapter of this.adapters.values()) {
      if (await adapter.answerQuestion(questionId, answer)) return true;
    }
    return false;
  }

  async archive(id: string): Promise<void> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    if (this.activeSessionIds.has(id)) {
      throw new RuntimeSessionError("Session is currently running", "SESSION_OCCUPIED");
    }
    if (!adapter.archiveSession) {
      throw new RuntimeSessionError("This session cannot be archived", "OPERATION_NOT_SUPPORTED");
    }
    await adapter.archiveSession(nativeSessionId);
    this.invalidate(id);
  }

  async delete(id: string): Promise<void> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    if (this.activeSessionIds.has(id)) {
      throw new RuntimeSessionError("Session is currently running", "SESSION_OCCUPIED");
    }
    if (!adapter.delete) {
      throw new RuntimeSessionError("This session cannot be deleted", "OPERATION_NOT_SUPPORTED");
    }
    await adapter.delete(nativeSessionId);
    this.detailCache.delete(id);
    this.discoveryPromise = null;
  }

  async dispose(): Promise<void> {
    this.codexCompatibility?.dispose();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.dispose?.()));
  }

  agentTypeFor(id: string): AgentType {
    return decodeUnifiedSessionId(id).agentType;
  }

  private resolveAdapter(id: string): { adapter: AgentRuntimeAdapter; nativeSessionId: string } {
    const decoded = decodeUnifiedSessionId(id);
    const adapter = this.adapters.get(decoded.agentType);
    if (!adapter) {
      throw new RuntimeSessionError(`Runtime is unavailable: ${decoded.agentType}`, "RUNTIME_UNAVAILABLE");
    }
    return { adapter, nativeSessionId: decoded.nativeSessionId };
  }

  private recordFailure(agentType: AgentType, error: unknown): void {
    const current = this.healthCache.find((entry) => entry.agentType === agentType);
    const failed: RuntimeHealth = {
      agentType,
      available: false,
      label: current?.label ?? agentType,
      error: error instanceof Error ? error.message : String(error),
    };
    this.healthCache = [...this.healthCache.filter((entry) => entry.agentType !== agentType), failed];
  }

  private cacheDetail(id: string, detail: UnifiedSessionDetail): void {
    this.detailCache.delete(id);
    this.detailCache.set(id, detail);
    while (this.detailCache.size > 3) {
      const oldest = this.detailCache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.detailCache.delete(oldest);
    }
  }
}

export function shouldReuseSessionDetailCache(query?: SessionHistoryQuery): boolean {
  return Boolean(query?.before || query?.after || query?.anchor);
}

function associateProject<T extends UnifiedSessionSummary>(session: T, projects: ProjectLike[]): T {
  if (session.projectId || !session.cwd) return session;
  const cwd = resolve(session.cwd);
  const match = projects
    .filter((project) => project.description)
    .map((project) => ({ project, path: resolve(project.description) }))
    .filter(({ path }) => cwd === path || cwd.startsWith(`${path}${sep}`))
    .sort((left, right) => right.path.length - left.path.length)[0];
  return match ? { ...session, projectId: match.project.id } : session;
}
