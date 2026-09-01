import { resolve, sep } from "node:path";
import type { AgentEvent } from "@agent/core";
import { decodeUnifiedSessionId } from "./session-id.js";
import type {
  AgentRuntimeAdapter,
  AgentType,
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";

interface ProjectLike {
  id: string;
  description: string;
}

export class UnifiedSessionService {
  private readonly adapters = new Map<AgentType, AgentRuntimeAdapter>();
  private readonly activeSessionIds = new Set<string>();
  private healthCache: RuntimeHealth[] = [];
  private discoveryPromise: Promise<UnifiedSessionSummary[]> | null = null;

  constructor(
    adapters: AgentRuntimeAdapter[],
    private readonly listProjects: () => Promise<ProjectLike[]>,
  ) {
    for (const adapter of adapters) this.adapters.set(adapter.agentType, adapter);
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

  async list(projectId?: string): Promise<UnifiedSessionSummary[]> {
    const sessions = await this.discoverAll();
    return sessions.filter((session) => projectId === undefined || session.projectId === projectId);
  }

  async refresh(projectId?: string): Promise<UnifiedSessionSummary[]> {
    this.discoveryPromise = null;
    return this.list(projectId);
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
        const sessions = await adapter.discoverSessions();
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

  async get(id: string): Promise<UnifiedSessionDetail> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    const detail = await adapter.getSession(nativeSessionId);
    const projects = await this.listProjects();
    return associateProject(detail, projects);
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

  async *run(
    id: string,
    input: string,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
  ): AsyncIterable<AgentEvent> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    const detail = await adapter.getSession(nativeSessionId);
    if (!detail.canResume || detail.occupancy === "owned-externally") {
      throw new RuntimeSessionError("Session is currently owned by another client", "SESSION_OCCUPIED");
    }
    if (this.activeSessionIds.has(id)) {
      throw new RuntimeSessionError("Session is already running", "SESSION_OCCUPIED");
    }
    this.activeSessionIds.add(id);
    try {
      yield* adapter.run(nativeSessionId, input, images, agentIds, agentName);
    } finally {
      this.activeSessionIds.delete(id);
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

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    for (const adapter of this.adapters.values()) {
      if (await adapter.answerQuestion(questionId, answer)) return true;
    }
    return false;
  }

  async delete(id: string): Promise<void> {
    const { adapter, nativeSessionId } = this.resolveAdapter(id);
    if (!adapter.delete || adapter.agentType !== "customer-agent") {
      throw new RuntimeSessionError("External runtime sessions cannot be deleted", "OPERATION_NOT_SUPPORTED");
    }
    await adapter.delete(nativeSessionId);
    this.discoveryPromise = null;
  }

  async dispose(): Promise<void> {
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
