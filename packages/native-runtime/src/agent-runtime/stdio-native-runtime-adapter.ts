import type { AgentEvent, Message } from "@agent/core";
import { basename } from "node:path";
import { normalizeAgentWorkspacePath, paginateByOffset } from "./agent-workspace-index.js";
import { encodeUnifiedSessionId } from "./session-id.js";
import type { BridgedNativeAgentType } from "./native-cli-command.js";
import { RuntimeSessionError, type AgentRuntimeAdapter, type AgentWorkspace, type CreateRuntimeSessionOptions, type NativeSessionPermissions, type RuntimeHealth, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions, type UnifiedSessionDetail, type UnifiedSessionSummary, type WorkspacePage, type WorkspaceQuery, type WorkspaceSessionQuery } from "./types.js";

export interface NativeProtocolSession {
  id: string;
  title: string;
  cwd: string;
  created: string;
  updated: string;
  running?: boolean;
  parentSessionId?: string;
  readOnly?: boolean;
  nativePermissions?: NativeSessionPermissions;
}

export interface NativeSessionProtocol {
  available(): Promise<void>;
  list(): Promise<NativeProtocolSession[]>;
  read(id: string): Promise<{ session: NativeProtocolSession; messages: Message[] }>;
  create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
  run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
  abort(id: string): Promise<void>;
  answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
  listModels(): Promise<RuntimeModelInfo[]>;
  restoreDraft?(session: NativeProtocolSession): void;
  dispose(): Promise<void>;
}

/** Shared facade projection; each native client retains its own wire protocol and history. */
export class StdioNativeRuntimeAdapter implements AgentRuntimeAdapter {
  private readonly running = new Set<string>();
  private readonly drafts = new Map<string, UnifiedSessionSummary>();

  constructor(readonly agentType: BridgedNativeAgentType, private readonly label: string, private readonly client: NativeSessionProtocol) {}

  async health(): Promise<RuntimeHealth> {
    try { await this.client.available(); return { agentType: this.agentType, label: this.label, available: true }; }
    catch (error) { return { agentType: this.agentType, label: this.label, available: false, error: error instanceof Error ? error.message : "Native runtime unavailable" }; }
  }

  private summary(session: NativeProtocolSession): UnifiedSessionSummary {
    const owned = this.running.has(session.id);
    return { id: encodeUnifiedSessionId(this.agentType, session.id), agentType: this.agentType, nativeSessionId: session.id,
      title: session.title || this.label, cwd: session.cwd, created: session.created, updated: session.updated,
      status: owned || session.running ? "running" : "idle", occupancy: owned ? "owned-by-customer-agent" : session.running ? "owned-externally" : "available",
      sourceLabel: this.label, canResume: !session.readOnly && (!session.running || owned), canDelete: false, nativePermissions: session.nativePermissions,
      ...(session.readOnly ? { readOnly: true } : {}),
      ...(session.parentSessionId ? { parentSessionId: encodeUnifiedSessionId(this.agentType, session.parentSessionId) } : {}) };
  }

  async discoverSessions(): Promise<UnifiedSessionSummary[]> {
    return (await this.client.list()).map(session => this.summary(session));
  }

  private workspaceId(cwd: string): string {
    return `${this.agentType}:cwd:${Buffer.from(cwd, "utf8").toString("base64url")}`;
  }

  private async workspaceSessions(): Promise<UnifiedSessionSummary[]> {
    const sessions = new Map<string, UnifiedSessionSummary>();
    for (const session of await this.discoverSessions()) {
      const previous = sessions.get(session.id);
      if (!previous || session.updated > previous.updated) sessions.set(session.id, session);
    }
    return [...sessions.values()]
      .sort((left, right) => right.updated.localeCompare(left.updated) || left.id.localeCompare(right.id));
  }

  private workspaceRoot(session: UnifiedSessionSummary, sessions: ReadonlyMap<string, UnifiedSessionSummary>): string {
    const visited = new Set([session.id]);
    let root = session;
    while (root.parentSessionId) {
      const parent = sessions.get(root.parentSessionId);
      if (!parent || visited.has(parent.id)) break;
      visited.add(parent.id);
      root = parent;
    }
    return root.cwd.trim() ? normalizeAgentWorkspacePath(root.cwd) : "";
  }

  private workspaceCatalog(sessions: readonly UnifiedSessionSummary[]): AgentWorkspace[] {
    const workspaces = new Map<string, AgentWorkspace>();
    const byId = new Map(sessions.map(session => [session.id, session]));
    for (const session of sessions) {
      const cwd = this.workspaceRoot(session, byId);
      if (!cwd) continue;
      if (workspaces.has(cwd)) continue;
      workspaces.set(cwd, {
        agentType: this.agentType,
        workspaceId: this.workspaceId(cwd),
        name: basename(cwd) || cwd,
        roots: [cwd],
        order: workspaces.size,
        updatedAt: session.updated,
        source: "derived",
      });
    }
    return [...workspaces.values()];
  }

  async listWorkspaces(query: WorkspaceQuery = {}): Promise<WorkspacePage<AgentWorkspace>> {
    const workspaces = this.workspaceCatalog(await this.workspaceSessions());
    return paginateByOffset(workspaces, query, workspaces[0]?.updatedAt ?? null);
  }

  async listWorkspaceSessions(workspaceId: string, query: WorkspaceSessionQuery = {}): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const sessions = await this.workspaceSessions();
    const workspace = this.workspaceCatalog(sessions).find(candidate => candidate.workspaceId === workspaceId);
    if (!workspace) throw new RuntimeSessionError(`${this.label} workspace not found: ${workspaceId}`, "SESSION_NOT_FOUND");
    return this.workspaceSessionPage(sessions, workspace.roots[0]!, query);
  }

  async listWorkspaceSessionsByPath(cwd: string, query: WorkspaceSessionQuery = {}): Promise<WorkspacePage<UnifiedSessionSummary>> {
    return this.workspaceSessionPage(await this.workspaceSessions(), cwd, query);
  }

  private workspaceSessionPage(sessions: readonly UnifiedSessionSummary[], cwd: string, query: WorkspaceSessionQuery): WorkspacePage<UnifiedSessionSummary> {
    const root = normalizeAgentWorkspacePath(cwd);
    const byId = new Map(sessions.map(session => [session.id, session]));
    // A native child can execute in another cwd but still belongs under its parent.
    const data = sessions.filter(session => this.workspaceRoot(session, byId) === root)
      .map(session => ({ ...session, projectId: this.workspaceId(root) }));
    return paginateByOffset(data, query, data[0]?.updated ?? null);
  }

  async getSession(id: string): Promise<UnifiedSessionDetail> {
    const detail = await this.client.read(id);
    return { ...this.drafts.get(id), ...this.summary(detail.session), messages: detail.messages, events: [] };
  }

  async create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary> {
    const summary = { ...this.summary(await this.client.create(options)), projectId: options.projectId };
    this.drafts.set(summary.nativeSessionId, summary);
    return summary;
  }

  restoreDraft(summary: UnifiedSessionSummary): void {
    if (summary.agentType !== this.agentType) return;
    this.drafts.set(summary.nativeSessionId, summary);
    this.client.restoreDraft?.({ id: summary.nativeSessionId, title: summary.title, cwd: summary.cwd, created: summary.created, updated: summary.updated });
  }

  async *run(id: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    if (this.running.has(id)) throw new RuntimeSessionError("Native session is already running", "SESSION_ALREADY_RUNNING");
    this.running.add(id);
    try { yield* this.client.run(id, input, images, options); }
    finally { this.running.delete(id); }
  }

  abort(id: string) { return this.client.abort(id); }
  answerQuestion(id: string, answer: RuntimeQuestionAnswer) { return this.client.answerQuestion(id, answer); }
  listModels() { return this.client.listModels(); }
  dispose() { return this.client.dispose(); }
}
