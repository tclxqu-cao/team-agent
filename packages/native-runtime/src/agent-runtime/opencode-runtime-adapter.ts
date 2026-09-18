import { logGlobal } from "@agent/core";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildSessionQueryIndex,
  classifyToolPermission,
  computeSessionHistoryRevision,
  normalizeToolPermissionMode,
  type AgentEvent,
  type Message,
  type MessageAttachment,
  type SessionHistoryQuery,
  type SessionQueryIndex,
  type ToolPermissionMode,
} from "@agent/core";
import type {
  Event,
  Message as OpenCodeMessage,
  Part,
  Permission,
  Session,
  SessionStatus,
  ToolPart,
  OpencodeClient,
} from "@opencode-ai/sdk";
import { AsyncEventQueue } from "./async-event-queue.js";
import { parseImageDataUrls } from "./image-input.js";
import {
  buildNativeHistoryPage,
  nativeHistorySkeleton,
  nativeHistoryWindow,
  selectNativeHistoryRange,
} from "./native-history-paging.js";
import { OpenCodeServerClient, type OpenCodeServerEvent } from "./opencode-server-client.js";
import { encodeUnifiedSessionId } from "./session-id.js";
import { paginateByOffset } from "./agent-workspace-index.js";
import type {
  AgentRuntimeAdapter,
  AgentWorkspace,
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

const execFileAsync = promisify(execFile);
// Kept in sync with the CLI minimum by checkRuntimeVersionDrift.
const OPENCODE_MINIMUM_VERSION = "1.18.27";

interface ActiveRun {
  queue: AsyncEventQueue<AgentEvent>;
  cwd: string;
  permissionMode: ToolPermissionMode;
  brokerRunId?: string;
  finalText: string;
  messageRoles: Map<string, OpenCodeMessage["role"]>;
  partText: Map<string, string>;
  toolStates: Map<string, ToolPart["state"]["status"]>;
}

interface PendingPermission {
  questionId: string;
  sessionId: string;
  directory: string;
  permissionId: string;
}

/** Conversion cache for native history paging, keyed by session id. */
interface OpenCodePagerState {
  fingerprint: string;
  messages: Message[];
}

export interface OpenCodeServerPort {
  client(): Promise<OpencodeClient>;
  subscribe(
    listener: (event: OpenCodeServerEvent) => void,
    onFailure?: (error: Error) => void,
  ): () => void;
  dispose(): Promise<void>;
}

type SessionWithRuntime = Session & {
  agent?: string;
  model?: { id?: string; providerID?: string };
};

export class OpenCodeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly agentType = "opencode" as const;
  private readonly server: OpenCodeServerPort;
  private readonly executable: string;
  private readonly unavailableError?: string;
  private readonly validateExecutable: boolean;
  private readonly onApprovalResolved?: (questionId: string) => void;
  private readonly dataRoot: string;
  private readonly activeRuns = new Map<string, ActiveRun>();
  private readonly ownedSessions = new Set<string>();
  private readonly sessionDirectories = new Map<string, string>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly workspaces = new Map<string, AgentWorkspace>();
  private readonly pagerStates = new Map<string, OpenCodePagerState>();
  private unsubscribe: (() => void) | null = null;
  private availabilityPromise: Promise<void> | null = null;

  constructor(options: {
    server?: OpenCodeServerPort;
    executable?: string;
    unavailableError?: string;
    environment?: NodeJS.ProcessEnv;
    dataRoot?: string;
    onApprovalResolved?: (questionId: string) => void;
  } = {}) {
    this.executable = options.executable?.trim() || "opencode";
    this.unavailableError = options.unavailableError?.trim() || undefined;
    this.validateExecutable = options.server === undefined;
    this.onApprovalResolved = options.onApprovalResolved;
    this.dataRoot = options.dataRoot ?? resolveOpenCodeDataRoot(options.environment);
    this.server = options.server ?? new OpenCodeServerClient({
      executable: this.executable,
      unavailableError: this.unavailableError,
      environment: options.environment,
    });
  }

  async health(): Promise<RuntimeHealth> {
    if (this.unavailableError) {
      return { agentType: this.agentType, available: false, label: "OpenCode", error: this.unavailableError };
    }
    try {
      const { stdout, stderr } = await execFileAsync(this.executable, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      const version = validatedOpenCodeVersion(`${stdout}\n${stderr}`, this.executable);
      await execFileAsync(this.executable, ["serve", "--help"], {
        encoding: "utf8",
        timeout: 5_000,
        windowsHide: true,
      });
      return {
        agentType: this.agentType,
        available: true,
        label: "OpenCode",
        version,
      };
    } catch (error) {
      return { agentType: this.agentType, available: false, label: "OpenCode", error: errorMessage(error) };
    }
  }

  /** Models from the opencode server's own provider configuration, keyed by provider. */
  async listModels(): Promise<RuntimeModelInfo[]> {
    const client = await this.getClient();
    const response = await client.config.providers({ throwOnError: true });
    const providers = (response.data as { providers?: Array<{ id?: string; models?: Record<string, { name?: string } > }> } | undefined)?.providers ?? [];
    const models: RuntimeModelInfo[] = [];
    for (const provider of providers) {
      if (!provider?.id) continue;
      for (const [modelID, model] of Object.entries(provider.models ?? {})) {
        if (!modelID) continue;
        models.push({
          id: modelID,
          providerID: provider.id,
          displayName: model?.name || `${provider.id}/${modelID}`,
        });
      }
    }
    return models;
  }

  async discoverSessions(): Promise<UnifiedSessionSummary[]> {
    const client = await this.getClient();
    const projects = (await client.project.list({ throwOnError: true })).data;
    const directories = [...new Set(projects.map((project) => project.worktree).filter(Boolean))];
    const batches = await Promise.all(directories.map(async (directory) => {
      const [sessions, statuses] = await Promise.all([
        client.session.list({ query: { directory }, throwOnError: true }).then((response) => response.data),
        client.session.status({ query: { directory }, throwOnError: true }).then((response) => response.data),
      ]);
      return sessions.map((session) => ({ session, status: statuses[session.id] }));
    }));
    const unique = new Map<string, UnifiedSessionSummary>();
    for (const { session, status } of batches.flat()) {
      this.sessionDirectories.set(session.id, session.directory);
      unique.set(session.id, openCodeSessionToSummary(session, status, this.ownedSessions.has(session.id)));
    }
    return [...unique.values()].sort((left, right) => right.updated.localeCompare(left.updated));
  }

  async listWorkspaces(query: WorkspaceQuery = {}): Promise<WorkspacePage<AgentWorkspace>> {
    const client = await this.getClient();
    const projects = (await client.project.list({ throwOnError: true })).data;
    const workspaces = projects.map((project, order): AgentWorkspace => {
      const named = project as typeof project & { name?: string };
      const workspace = {
        agentType: this.agentType,
        workspaceId: project.id,
        name: named.name?.trim() || basename(project.worktree) || project.worktree,
        roots: [project.worktree],
        order,
        updatedAt: new Date(project.time.initialized ?? project.time.created).toISOString(),
        source: "native" as const,
      };
      this.workspaces.set(workspace.workspaceId, workspace);
      return workspace;
    });
    return paginateByOffset(
      workspaces,
      query,
      String(Math.max(0, ...projects.map((project) => project.time.initialized ?? project.time.created))),
    );
  }

  async listWorkspaceSessions(
    workspaceId: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const client = await this.getClient();
    let workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      const page = await this.listWorkspaces({ limit: 200, refresh: true });
      workspace = page.data.find((candidate) => candidate.workspaceId === workspaceId);
    }
    const directory = workspace?.roots[0];
    if (!directory) throw new RuntimeSessionError(`OpenCode workspace not found: ${workspaceId}`, "SESSION_NOT_FOUND");
    const page = await this.listWorkspaceSessionsByPath(directory, query);
    return { ...page, watermark: page.watermark ?? workspace?.updatedAt ?? null };
  }

  async listWorkspaceSessionsByPath(
    directory: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> {
    const client = await this.getClient();
    const [sessions, statuses] = await Promise.all([
      client.session.list({ query: { directory }, throwOnError: true }).then((response) => response.data),
      client.session.status({ query: { directory }, throwOnError: true }).then((response) => response.data),
    ]);
    const summaries = sessions.map((session) => {
      this.sessionDirectories.set(session.id, session.directory);
      return openCodeSessionToSummary(session, statuses[session.id], this.ownedSessions.has(session.id));
    });
    return paginateByOffset(summaries, query, summaries[0]?.updated ?? null);
  }

  async getSession(nativeSessionId: string): Promise<UnifiedSessionDetail> {
    const client = await this.getClient();
    const directory = await this.resolveDirectory(nativeSessionId);
    try {
      const [session, messages, statuses] = await Promise.all([
        client.session.get({ path: { id: nativeSessionId }, query: { directory }, throwOnError: true }).then((r) => r.data),
        client.session.messages({ path: { id: nativeSessionId }, query: { directory }, throwOnError: true }).then((r) => r.data),
        client.session.status({ query: { directory }, throwOnError: true }).then((r) => r.data),
      ]);
      this.sessionDirectories.set(session.id, session.directory);
      return {
        ...openCodeSessionToSummary(session, statuses[session.id], this.ownedSessions.has(session.id)),
        messages: this.convertHistory(nativeSessionId, messages),
        events: [],
      };
    } catch (error) {
      throw normalizeOpenCodeError(error, nativeSessionId);
    }
  }

  /**
   * Source-paginated history over the opencode message list.
   *
   * The ordinal space counts visible user/assistant messages of the converted
   * history (tool results ride along and never consume an ordinal), with the
   * same cursor semantics as the other native runtimes. Conversion is cached
   * per message fingerprint so flipping pages skips re-mapping.
   */
  async getSessionPaged(nativeSessionId: string, query: SessionHistoryQuery): Promise<UnifiedSessionDetail> {
    const client = await this.getClient();
    const directory = await this.resolveDirectory(nativeSessionId);
    let session: Session;
    let history: Array<{ info: OpenCodeMessage; parts: Part[] }>;
    let statuses: Record<string, SessionStatus>;
    try {
      [session, history, statuses] = await Promise.all([
        client.session.get({ path: { id: nativeSessionId }, query: { directory }, throwOnError: true }).then((r) => r.data),
        client.session.messages({ path: { id: nativeSessionId }, query: { directory }, throwOnError: true }).then((r) => r.data),
        client.session.status({ query: { directory }, throwOnError: true }).then((r) => r.data),
      ]);
    } catch (error) {
      throw normalizeOpenCodeError(error, nativeSessionId);
    }
    this.sessionDirectories.set(session.id, session.directory);
    const summary = openCodeSessionToSummary(session, statuses[session.id], this.ownedSessions.has(session.id));
    const messages = this.convertHistory(nativeSessionId, history);
    const revision = computeSessionHistoryRevision(messages);
    const skeleton = nativeHistorySkeleton(messages);
    const skeletonMessages = skeleton.map((index) => messages[index]);
    const { start, end, kind } = selectNativeHistoryRange(skeletonMessages, query, revision);
    const page = buildNativeHistoryPage(messages, skeleton, start, end, []);
    return {
      ...summary,
      messages: page.messages,
      events: [],
      history: nativeHistoryWindow(start, end, skeleton.length, kind, revision, query.view ?? "legacy-full"),
    };
  }

  /** Query index over the converted history (same ordinal space as getSessionPaged). */
  async getQueryIndex(nativeSessionId: string): Promise<SessionQueryIndex | null> {
    const client = await this.getClient();
    const directory = await this.resolveDirectory(nativeSessionId);
    const history = await client.session
      .messages({ path: { id: nativeSessionId }, query: { directory }, throwOnError: true })
      .then((r) => r.data)
      .catch((error: unknown) => {
        throw normalizeOpenCodeError(error, nativeSessionId);
      });
    const messages = this.convertHistory(nativeSessionId, history);
    return buildSessionQueryIndex(encodeUnifiedSessionId(this.agentType, nativeSessionId), messages);
  }

  private convertHistory(
    nativeSessionId: string,
    history: Array<{ info: OpenCodeMessage; parts: Part[] }>,
  ): Message[] {
    const fingerprint = `${history.length}:${history.at(-1)?.info.id ?? ""}`;
    const cached = this.pagerStates.get(nativeSessionId);
    if (cached && cached.fingerprint === fingerprint) return cached.messages;
    const messages = openCodeHistoryToMessages(history);
    this.pagerStates.set(nativeSessionId, { fingerprint, messages });
    while (this.pagerStates.size > 32) {
      const oldest = this.pagerStates.keys().next().value as string | undefined;
      if (!oldest) break;
      this.pagerStates.delete(oldest);
    }
    return messages;
  }

  async getSessionWatchPath(nativeSessionId: string): Promise<string | null> {
    await this.resolveDirectory(nativeSessionId);
    const database = join(this.dataRoot, "opencode.db");
    const wal = `${database}-wal`;
    return existsSync(wal) ? wal : database;
  }

  async create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary> {
    const client = await this.getClient();
    const session = (await client.session.create({
      body: { title: options.title },
      query: { directory: options.cwd },
      throwOnError: true,
    })).data;
    this.sessionDirectories.set(session.id, session.directory);
    return openCodeSessionToSummary(session, { type: "idle" });
  }

  async fork(nativeSessionId: string): Promise<UnifiedSessionSummary> {
    const client = await this.getClient();
    const directory = await this.resolveDirectory(nativeSessionId);
    const session = (await client.session.fork({
      path: { id: nativeSessionId },
      query: { directory },
      throwOnError: true,
    })).data;
    this.sessionDirectories.set(session.id, session.directory);
    return openCodeSessionToSummary(session, { type: "idle" });
  }

  async *run(
    nativeSessionId: string,
    input: string,
    images?: string[],
    _agentIds?: string[],
    _agentName?: string,
    options?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent> {
    if (this.activeRuns.has(nativeSessionId)) {
      throw new RuntimeSessionError("OpenCode session is already running", "SESSION_ALREADY_RUNNING");
    }
    const detail = await this.getSession(nativeSessionId);
    if (detail.occupancy === "owned-externally") {
      throw new RuntimeSessionError("OpenCode session is open in another client", "SESSION_OCCUPIED");
    }
    const queue = new AsyncEventQueue<AgentEvent>();
    const run: ActiveRun = {
      queue,
      cwd: detail.cwd,
      permissionMode: normalizeToolPermissionMode(options?.permissionMode),
      brokerRunId: options?.brokerRunId,
      finalText: "",
      messageRoles: new Map(),
      partText: new Map(),
      toolStates: new Map(),
    };
    this.activeRuns.set(nativeSessionId, run);
    this.ownedSessions.add(nativeSessionId);
    try {
      const client = await this.getClient();
      const messageID = `msg_${randomUUID()}`;
      run.messageRoles.set(messageID, "user");
      const imageParts = parseImageDataUrls(images).map((image, index) => ({
        type: "file" as const,
        mime: image.mimeType,
        filename: `image-${index + 1}.${image.extension}`,
        url: `data:${image.mimeType};base64,${image.base64}`,
      }));
      await client.session.promptAsync({
        path: { id: nativeSessionId },
        query: { directory: detail.cwd },
        body: {
          messageID,
          parts: [{ type: "text", text: input }, ...imageParts],
          ...(options?.model?.id && options.model.providerID
            ? { model: { providerID: options.model.providerID, modelID: options.model.id } }
            : {}),
        },
        throwOnError: true,
      });
      for await (const event of queue) yield event;
    } catch (error) {
      logGlobal("error", "opencode-adapter", "opencode run failed", error, {
        nativeSessionId,
        message: errorMessage(error),
      });
      yield { type: "error", message: errorMessage(error), code: "NATIVE_PROTOCOL_ERROR" };
    } finally {
      this.activeRuns.delete(nativeSessionId);
      this.ownedSessions.delete(nativeSessionId);
      for (const [questionId, pending] of this.pendingPermissions) {
        if (pending.sessionId === nativeSessionId) this.pendingPermissions.delete(questionId);
      }
    }
  }

  async abort(nativeSessionId: string): Promise<void> {
    const ids = nativeSessionId ? [nativeSessionId] : [...this.activeRuns.keys()];
    const client = await this.getClient();
    await Promise.all(ids.map(async (id) => {
      const directory = await this.resolveDirectory(id);
      await client.session.abort({ path: { id }, query: { directory }, throwOnError: true });
      const run = this.activeRuns.get(id);
      if (run) {
        run.queue.push({ type: "turn_aborted" });
        run.queue.close();
      }
    }));
  }

  async answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> {
    const pending = this.pendingPermissions.get(questionId);
    if (!pending) return false;
    this.pendingPermissions.delete(questionId);
    const response = permissionResponse(answer);
    const client = await this.getClient();
    await client.postSessionIdPermissionsPermissionId({
      path: { id: pending.sessionId, permissionID: pending.permissionId },
      query: { directory: pending.directory },
      body: { response },
      throwOnError: true,
    });
    this.onApprovalResolved?.(questionId);
    return true;
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.server.dispose();
  }

  private async getClient() {
    if (this.validateExecutable) {
      this.availabilityPromise ??= this.ensureCompatibleExecutable();
      await this.availabilityPromise;
    }
    if (!this.unsubscribe) {
      this.unsubscribe = this.server.subscribe(
        (event) => this.handleEvent(event),
        (error) => this.handleFailure(error),
      );
    }
    return this.server.client();
  }

  private async ensureCompatibleExecutable(): Promise<void> {
    const health = await this.health();
    if (!health.available) {
      throw new RuntimeSessionError(health.error || "OpenCode runtime is unavailable", "RUNTIME_UNAVAILABLE");
    }
  }

  private async resolveDirectory(sessionId: string): Promise<string> {
    const known = this.sessionDirectories.get(sessionId);
    if (known) return known;
    const discovered = await this.discoverSessions();
    const session = discovered.find((candidate) => candidate.nativeSessionId === sessionId);
    if (!session) throw new RuntimeSessionError(`OpenCode session not found: ${sessionId}`, "SESSION_NOT_FOUND");
    return session.cwd;
  }

  private handleEvent({ directory, payload }: OpenCodeServerEvent): void {
    const sessionId = eventSessionId(payload);
    if (!sessionId) return;
    this.sessionDirectories.set(sessionId, directory);
    const run = this.activeRuns.get(sessionId);
    if (!run) return;

    if (payload.type === "message.updated") {
      run.messageRoles.set(payload.properties.info.id, payload.properties.info.role);
      const error = payload.properties.info.role === "assistant" ? payload.properties.info.error : undefined;
      if (error) this.failRun(sessionId, errorMessage(error));
      return;
    }
    if (payload.type === "message.part.updated") {
      this.handlePart(run, payload.properties.part, payload.properties.delta);
      return;
    }
    if (payload.type === "todo.updated") {
      run.queue.push({
        type: "todo_update",
        todos: payload.properties.todos.map((todo) => ({
          id: todo.id,
          title: todo.content,
          status: todo.status === "in_progress" ? "in-progress" : todo.status === "completed" ? "completed" : "pending",
        })),
      });
      return;
    }
    if (payload.type === "permission.updated") {
      void this.handlePermission(run, directory, payload.properties);
      return;
    }
    if (payload.type === "permission.replied") {
      const pending = [...this.pendingPermissions.values()].find((value) => value.permissionId === payload.properties.permissionID);
      if (pending) {
        this.pendingPermissions.delete(pending.questionId);
        this.onApprovalResolved?.(pending.questionId);
      }
      return;
    }
    if (payload.type === "session.status" && payload.properties.status.type === "retry") {
      run.queue.push({
        type: "runtime_progress",
        progressId: "opencode:retry",
        phase: "retry",
        label: `OpenCode retry ${payload.properties.status.attempt}`,
        detail: payload.properties.status.message,
      });
      return;
    }
    if (payload.type === "session.idle"
      || (payload.type === "session.status" && payload.properties.status.type === "idle")) {
      run.queue.push({ type: "text_done" });
      run.queue.push({ type: "done", finalText: run.finalText });
      run.queue.close();
      return;
    }
    if (payload.type === "session.error") {
      this.failRun(sessionId, errorMessage(payload.properties.error ?? "OpenCode session failed"));
    }
  }

  private handlePart(run: ActiveRun, part: Part, delta?: string): void {
    if (part.type === "text") {
      if (run.messageRoles.get(part.messageID) === "user") return;
      const previous = run.partText.get(part.id) ?? "";
      const chunk = delta ?? (part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text);
      run.partText.set(part.id, part.text);
      if (chunk) {
        run.finalText += chunk;
        run.queue.push({ type: "text_chunk", text: chunk });
      }
      return;
    }
    if (part.type === "reasoning") {
      const previous = run.partText.get(part.id) ?? "";
      const chunk = delta ?? (part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text);
      run.partText.set(part.id, part.text);
      if (chunk) run.queue.push({ type: "reasoning_summary_delta", itemId: part.id, sectionIndex: 0, delta: chunk });
      return;
    }
    if (part.type === "retry") {
      run.queue.push({
        type: "runtime_progress",
        progressId: `opencode:retry:${part.id}`,
        phase: "retry",
        label: `OpenCode retry ${part.attempt}`,
        detail: errorMessage(part.error),
      });
      return;
    }
    if (part.type !== "tool") return;
    const previous = run.toolStates.get(part.callID);
    const status = part.state.status;
    run.toolStates.set(part.callID, status);
    if (previous === undefined) {
      run.queue.push({
        type: "tool_call",
        toolCall: { id: part.callID, name: part.tool, arguments: part.state.input },
      });
    }
    if (status === "running") {
      run.queue.push({
        type: "runtime_progress",
        progressId: `opencode:tool:${part.callID}`,
        phase: "tool",
        label: part.state.title || part.tool,
        toolCallId: part.callID,
      });
    }
    if ((status === "completed" || status === "error") && previous !== status) {
      run.queue.push({
        type: "tool_result",
        result: {
          toolCallId: part.callID,
          content: status === "completed" ? part.state.output : part.state.error,
          isError: status === "error" || undefined,
          metadata: part.state.metadata,
        },
      });
    }
  }

  private async handlePermission(run: ActiveRun, directory: string, permission: Permission): Promise<void> {
    const mapped = openCodePermissionTool(permission);
    const classification = classifyToolPermission(mapped.name, mapped.arguments, run.cwd);
    const shouldAutoApprove = run.permissionMode === "full-access"
      || (run.permissionMode === "auto-approval"
        && (classification.kind === "safe" || classification.kind === "workspace-write"));
    if (shouldAutoApprove) {
      const client = await this.getClient();
      await client.postSessionIdPermissionsPermissionId({
        path: { id: permission.sessionID, permissionID: permission.id },
        query: { directory },
        body: { response: "once" },
        throwOnError: true,
      }).catch((error) => this.failRun(permission.sessionID, errorMessage(error)));
      return;
    }

    const questionId = run.brokerRunId
      ? `native:${run.brokerRunId}:${permission.id}`
      : `opencode:${permission.sessionID}:${permission.id}`;
    this.pendingPermissions.set(questionId, {
      questionId,
      sessionId: permission.sessionID,
      directory,
      permissionId: permission.id,
    });
    run.queue.push({
      type: "ask_user",
      questionId,
      question: permission.title || classification.summary,
      options: [
        { label: "允许一次", description: classification.reason },
        { label: "本会话允许", description: "Allow matching OpenCode operations for this session" },
        { label: "拒绝", description: "Decline this operation" },
      ],
    });
  }

  private failRun(sessionId: string, message: string): void {
    const run = this.activeRuns.get(sessionId);
    if (!run) return;
    run.queue.push({ type: "error", message, code: "NATIVE_PROTOCOL_ERROR" });
    run.queue.close();
  }

  private handleFailure(error: Error): void {
    for (const sessionId of this.activeRuns.keys()) this.failRun(sessionId, error.message);
  }
}

export function openCodeSessionToSummary(
  session: Session,
  status: SessionStatus | undefined,
  ownedByUs = false,
): UnifiedSessionSummary {
  const active = status?.type === "busy" || status?.type === "retry";
  const externallyActive = active && !ownedByUs;
  const runtime = session as SessionWithRuntime;
  const model = runtime.model?.id
    ? `${runtime.model.providerID ? `${runtime.model.providerID}/` : ""}${runtime.model.id}`
    : undefined;
  const sourceDetails = [runtime.agent, model].filter(Boolean).join(" · ");
  return {
    id: encodeUnifiedSessionId("opencode", session.id),
    agentType: "opencode",
    nativeSessionId: session.id,
    title: session.title || "OpenCode session",
    cwd: session.directory,
    parentSessionId: session.parentID ? encodeUnifiedSessionId("opencode", session.parentID) : undefined,
    created: new Date(session.time.created).toISOString(),
    updated: new Date(session.time.updated).toISOString(),
    status: active ? "running" : "idle",
    occupancy: externallyActive ? "owned-externally" : ownedByUs ? "owned-by-customer-agent" : "available",
    sourceLabel: sourceDetails ? `OpenCode · ${sourceDetails}` : "OpenCode",
    canResume: !externallyActive,
    canDelete: false,
  };
}

export function resolveOpenCodeDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const explicit = environment.XDG_DATA_HOME?.trim();
  if (explicit) return resolve(explicit, "opencode");
  if (process.platform === "win32" && environment.LOCALAPPDATA?.trim()) {
    return resolve(environment.LOCALAPPDATA, "opencode");
  }
  return join(homedir(), ".local", "share", "opencode");
}

export function openCodeHistoryToMessages(
  history: Array<{ info: OpenCodeMessage; parts: Part[] }>,
): Message[] {
  const messages: Message[] = [];
  for (const entry of history) {
    const text = entry.parts
      .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text" && !part.ignored)
      .map((part) => part.text)
      .join("");
    const files = entry.parts.filter((part): part is Extract<Part, { type: "file" }> => part.type === "file");
    const imageFiles = files.filter((part) => part.mime.startsWith("image/"));
    const attachments: MessageAttachment[] = imageFiles.map((part) => ({
      type: "image",
      name: part.filename || "image",
      dataUrl: part.mime.startsWith("image/") && part.url.startsWith("data:") ? part.url : undefined,
      unavailable: !part.url.startsWith("data:"),
    }));
    const reasoning = entry.parts
      .filter((part): part is Extract<Part, { type: "reasoning" }> => part.type === "reasoning")
      .map((part, index) => ({ itemId: part.id, sectionIndex: index, text: part.text }));
    const tools = entry.parts.filter((part): part is ToolPart => part.type === "tool");
    const message: Message = {
      role: entry.info.role,
      content: text,
      ...(imageFiles.filter((part) => part.url.startsWith("data:" )).length > 0
        ? { images: imageFiles.filter((part) => part.url.startsWith("data:" )).map((part) => part.url) }
        : {}),
      ...(attachments.length > 0 || reasoning.length > 0
        ? { presentation: { attachments: attachments.length ? attachments : undefined, reasoning: reasoning.length ? reasoning : undefined } }
        : {}),
      ...(tools.length > 0 ? {
        toolCalls: tools.map((part) => ({ id: part.callID, name: part.tool, arguments: part.state.input })),
      } : {}),
    };
    if (message.content || message.images?.length || message.toolCalls?.length || reasoning.length) messages.push(message);
    for (const part of tools) {
      if (part.state.status !== "completed" && part.state.status !== "error") continue;
      messages.push({
        role: "tool",
        toolCallId: part.callID,
        content: part.state.status === "completed" ? part.state.output : part.state.error,
      });
    }
  }
  return messages;
}

function eventSessionId(event: unknown): string | undefined {
  if (!isRecord(event) || typeof event.type !== "string" || !isRecord(event.properties)) return undefined;
  const properties = event.properties;
  if (event.type === "message.updated") {
    return isRecord(properties.info) && typeof properties.info.sessionID === "string"
      ? properties.info.sessionID
      : undefined;
  }
  if (event.type === "message.part.updated") {
    return isRecord(properties.part) && typeof properties.part.sessionID === "string"
      ? properties.part.sessionID
      : undefined;
  }
  return typeof properties.sessionID === "string"
    ? properties.sessionID
    : isRecord(properties.info) && typeof properties.info.id === "string" && event.type.startsWith("session.")
      ? properties.info.id
      : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function openCodePermissionTool(permission: Permission): { name: string; arguments: Record<string, unknown> } {
  const aliases: Record<string, string> = {
    read: "read_file",
    list: "list_files",
    glob: "list_files",
    grep: "search_files",
    edit: "apply_patch",
    write: "write_file",
    patch: "apply_patch",
    bash: "bash",
    webfetch: "web_fetch",
    websearch: "web_search",
    task: "dispatch_agent",
    todowrite: "todo_write",
  };
  const pattern = Array.isArray(permission.pattern) ? permission.pattern.join(" ") : permission.pattern;
  return {
    name: aliases[permission.type.toLowerCase()] ?? permission.type,
    arguments: {
      ...permission.metadata,
      ...(permission.type.toLowerCase() === "bash" && pattern ? { command: pattern } : {}),
      ...(pattern ? { pattern } : {}),
    },
  };
}

function permissionResponse(answer: RuntimeQuestionAnswer): "once" | "always" | "reject" {
  const value = answer.answer.trim();
  if (value === "本会话允许" || value === "always" || answer.selectedIndices?.[0] === 1) return "always";
  if (value === "允许一次" || value === "once" || answer.selectedIndices?.[0] === 0) return "once";
  return "reject";
}

function normalizeOpenCodeError(error: unknown, sessionId: string): RuntimeSessionError {
  const message = errorMessage(error);
  if (/not found|404/i.test(message)) {
    return new RuntimeSessionError(`OpenCode session not found: ${sessionId}`, "SESSION_NOT_FOUND");
  }
  return new RuntimeSessionError(message, "NATIVE_PROTOCOL_ERROR");
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const data = record.data as Record<string, unknown> | undefined;
    if (typeof data?.message === "string") return data.message;
    if (typeof record.message === "string") return record.message;
  }
  return String(error);
}

function validatedOpenCodeVersion(output: string, executable: string): string {
  const version = output.match(/(?:^|\s)((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\s|$)/)?.[1];
  if (!version) throw new Error(`Unable to parse OpenCode version from ${executable}`);
  if (!meetsOpenCodeMinimum(version)) {
    throw new Error(`OpenCode ${version} at ${executable} is incompatible; AgentRoam requires >=${OPENCODE_MINIMUM_VERSION}`);
  }
  return version;
}

// Compare numeric components, so 1.18.100 and 1.19.0 both exceed 1.18.27.
function meetsOpenCodeMinimum(version: string): boolean {
  const actual = version.split(".").map(BigInt);
  const minimum = OPENCODE_MINIMUM_VERSION.split(".").map(BigInt);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}
