import { normalizeToolPermissionMode, readSessionGoalState, type AgentEvent } from "@agent/core";
import type { AgentHost } from "../agent-host.js";
import { paginateByOffset } from "./agent-workspace-index.js";
import type {
  AgentRuntimeAdapter,
  AgentWorkspace,
  CreateRuntimeSessionOptions,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
  WorkspacePage,
  WorkspaceQuery,
  WorkspaceSessionQuery,
} from "./types.js";
import { RuntimeSessionError } from "./types.js";

export class CustomerAgentRuntimeAdapter implements AgentRuntimeAdapter {
  readonly agentType = "customer-agent" as const;
  private readonly activeSessions = new Set<string>();

  constructor(private readonly host: AgentHost) {}

  async health(): Promise<RuntimeHealth> {
    return { agentType: this.agentType, available: true, label: "Customer Agent" };
  }

  async discoverSessions(): Promise<UnifiedSessionSummary[]> {
    const sessions = await this.host.getSessionStore().list();
    return Promise.all(sessions.map((session) => this.toSummary(session)));
  }

  async listWorkspaces(query: WorkspaceQuery = {}): Promise<WorkspacePage<AgentWorkspace>> {
    const projects = await this.host.getProjectStore().list();
    const workspaces = projects.map((project, order): AgentWorkspace => ({
      agentType: this.agentType,
      workspaceId: project.id,
      name: project.name,
      roots: project.description ? [project.description] : [],
      order,
      updatedAt: project.updated,
      source: "native",
    }));
    return paginateByOffset(workspaces, query, workspaces[0]?.updatedAt ?? null);
  }

  async listWorkspaceSessions(
    workspaceId: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const project = await this.host.getProjectStore().get(workspaceId);
    if (!project) {
      throw new RuntimeSessionError(`Customer Agent workspace not found: ${workspaceId}`, "SESSION_NOT_FOUND");
    }
    const sessions = await this.host.getSessionStore().list(workspaceId);
    const summaries = await Promise.all(sessions.map((session) => this.toSummary(session)));
    return paginateByOffset(summaries, query, summaries[0]?.updated ?? project.updated);
  }

  async getSession(nativeSessionId: string): Promise<UnifiedSessionDetail> {
    const session = await this.host.getSessionStore().get(nativeSessionId);
    if (!session) {
      throw new RuntimeSessionError(`Customer Agent session not found: ${nativeSessionId}`, "SESSION_NOT_FOUND");
    }
    return {
      ...await this.toSummary(session),
      messages: session.messages,
      events: session.events,
    };
  }

  async create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary> {
    const session = await this.host.createSession(options.title, options.projectId);
    return this.toSummary(session);
  }

  async *run(
    nativeSessionId: string,
    input: string,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
  ): AsyncIterable<AgentEvent> {
    if (this.activeSessions.has(nativeSessionId)) {
      throw new RuntimeSessionError("Customer Agent session is already running", "SESSION_OCCUPIED");
    }
    this.activeSessions.add(nativeSessionId);
    this.host.setRunning(true);
    try {
      yield* this.host.run(input, nativeSessionId, agentIds, agentName, images);
    } finally {
      this.host.setRunning(false);
      this.activeSessions.delete(nativeSessionId);
    }
  }

  async abort(_nativeSessionId: string): Promise<void> {
    this.host.abort();
  }

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    return this.host.answerQuestion(questionId, answer.answer, answer.selectedIndices);
  }

  async delete(nativeSessionId: string): Promise<void> {
    await this.host.onSessionDeleted(nativeSessionId);
    await this.host.getSessionStore().delete(nativeSessionId);
  }

  private async toSummary(session: Awaited<ReturnType<AgentHost["createSession"]>>): Promise<UnifiedSessionSummary> {
    const project = session.projectId
      ? await this.host.getProjectStore().get(session.projectId)
      : null;
    const owned = this.activeSessions.has(session.id);
    return {
      // Keep existing IDs on the wire so cron, sub-session, and persisted UI
      // references remain backward compatible. The decoder treats these as CA.
      id: session.id,
      agentType: this.agentType,
      nativeSessionId: session.id,
      title: session.title,
      cwd: project?.description || this.host.getSettings().workingDirectory || "",
      projectId: session.projectId || undefined,
      parentSessionId: session.parentSessionId,
      created: session.created,
      updated: session.updated,
      status: owned
        ? "running"
        : session.status === "failed"
          ? "failed"
          : session.status === "completed"
            ? "completed"
            : "idle",
      occupancy: owned ? "owned-by-customer-agent" : "available",
      sourceLabel: "Customer Agent",
      canResume: true,
      canDelete: !owned,
      permissionMode: normalizeToolPermissionMode(session.metadata.permissionMode),
      goalState: readSessionGoalState(session.metadata),
    };
  }
}
