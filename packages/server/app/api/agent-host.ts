import {
  AgentBuilder,
  HostPathPolicy,
  SQLiteSessionStore,
  AskUserTool,
  type IAgentLoop,
  type AgentEvent,
  type Session,
  type AskUserRequest,
  type AskUserResponse,
  getDatabase,
  SQLiteProjectStore,
  SQLiteRemoteToolStore,
  type RemoteToolRegistration,
  type Message,
  type MessageAttachment,
  ToolPermissionGate,
  TOOL_APPROVAL_OPTIONS,
  isToolPermissionMode,
  normalizeToolPermissionMode,
  toolApprovalDecisionFromAnswer,
  type ToolPermissionMode,
  withPendingAutoTitle,
} from "@agent/core";
import { homedir } from "node:os";
import { getAgentWorkingDirectory, getServerBaseDir } from "../../lib/server-data-dir";

const IMAGE_FILE_EXTENSIONS: Record<string, string> = {
  jpeg: "jpg",
  png: "png",
  gif: "gif",
  webp: "webp",
};

function sentImagePresentation(images?: readonly string[]): Message["presentation"] | undefined {
  const attachments: MessageAttachment[] = [];
  for (const [index, dataUrl] of (images ?? []).entries()) {
    const match = /^data:image\/(jpeg|png|gif|webp);base64,/i.exec(dataUrl);
    if (!match) continue;
    attachments.push({
      type: "image",
      name: `image-${index + 1}.${IMAGE_FILE_EXTENSIONS[match[1].toLowerCase()]}`,
      dataUrl,
    });
  }
  return attachments.length > 0 ? { attachments } : undefined;
}

export class ProjectWorkingDirectoryError extends Error {
  constructor(
    message: string,
    readonly code: "PROJECT_NOT_FOUND" | "PROJECT_PATH_REQUIRED" | "PROJECT_PATH_INVALID",
    readonly status: 400 | 404,
  ) {
    super(message);
    this.name = "ProjectWorkingDirectoryError";
  }
}

const ACTIVE_RUN_METADATA_KEY = "customerAgentActiveRun";

interface CustomerAgentRunMarker {
  runId: string;
  eventStart: number;
  startedAt: string;
}

interface ActiveCustomerAgentRun {
  runId: string;
  agent: IAgentLoop | null;
}

export class CustomerAgentRunConflictError extends Error {
  readonly code = "SESSION_ALREADY_RUNNING";

  constructor(readonly sessionId: string) {
    super(`Customer Agent session is already running: ${sessionId}`);
    this.name = "CustomerAgentRunConflictError";
  }
}

function readRunMarker(metadata: Record<string, unknown>): CustomerAgentRunMarker | null {
  const value = metadata[ACTIVE_RUN_METADATA_KEY];
  if (!value || typeof value !== "object") return null;
  const marker = value as Partial<CustomerAgentRunMarker>;
  return typeof marker.runId === "string"
    && Number.isSafeInteger(marker.eventStart)
    && (marker.eventStart ?? -1) >= 0
    && typeof marker.startedAt === "string"
    ? marker as CustomerAgentRunMarker
    : null;
}

/** Singleton agent host shared across API routes */
class AgentHost {
  private readonly baseDir = getServerBaseDir();
  private readonly workingDirectory = getAgentWorkingDirectory();
  private builder: AgentBuilder | null = null;
  private readonly sessionStore = new SQLiteSessionStore(this.baseDir);
  private readonly projectStore = new SQLiteProjectStore(this.baseDir);
  private readonly remoteToolStore = new SQLiteRemoteToolStore(getDatabase(this.baseDir).db);
  private readonly defaultRemoteToolsProjectId = process.env.AGENT_PROJECT_ID ?? "default";
  private readonly activeRuns = new Map<string, ActiveCustomerAgentRun>();
  private subscribers = new Map<string, Set<(event: AgentEvent, id: number) => void>>();
  /** events of the current run per session — replayed to late/reconnecting subscribers */
  private recentEvents = new Map<string, { id: number; event: AgentEvent }[]>();
  private eventCounters = new Map<string, number>();
  private pendingQuestions = new Map<
    string,
    {
      resolve: (response: AskUserResponse) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      sessionId: string;
    }
  >();
  private readonly toolPermissionGate: ToolPermissionGate;

  constructor() {
    this.toolPermissionGate = new ToolPermissionGate({
      resolveMode: async (sessionId) => {
        const session = await this.sessionStore.get(sessionId);
        return normalizeToolPermissionMode(session?.metadata.permissionMode);
      },
      requestApproval: async (request) => {
        const response = await this.createQuestion({
          question: `Customer Agent 请求权限\n${request.summary}\n原因：${request.reason}`,
          options: [...TOOL_APPROVAL_OPTIONS],
          toolCallId: "",
        }, request.sessionId);
        return toolApprovalDecisionFromAnswer(response.answer, response.selectedIndices);
      },
    });
    // Configure model from environment variables
    const apiKey = process.env.AGENT_API_KEY;
    const provider = (process.env.AGENT_MODEL_PROVIDER || "openai") as
      | "anthropic" | "openai" | "deepseek";
    const modelId = process.env.AGENT_MODEL_ID || "gpt-4o";
    const baseUrl = process.env.AGENT_BASE_URL || undefined;

    const builder = new AgentBuilder()
      .withSessionStore(this.sessionStore)
      .withWorkingDirectory(this.workingDirectory)
      .withToolPermissionGate(this.toolPermissionGate);
    builder.withRemoteToolStore(this.remoteToolStore, this.defaultRemoteToolsProjectId);
    if (apiKey) {
      builder.withModel(provider, { apiKey, modelId, baseUrl });
    }
    this.builder = builder;
  }

  getBuilder(): AgentBuilder {
    if (!this.builder) {
      this.builder = new AgentBuilder().withToolPermissionGate(this.toolPermissionGate);
    }
    return this.builder;
  }

  setBuilder(builder: AgentBuilder): void {
    builder.withRemoteToolStore(this.remoteToolStore, this.defaultRemoteToolsProjectId);
    builder.withWorkingDirectory(this.workingDirectory);
    builder.withToolPermissionGate(this.toolPermissionGate);
    this.builder = builder;
  }

  getSessionStore() {
    return this.sessionStore;
  }

  isSessionRunning(sessionId: string): boolean {
    return this.activeRuns.has(sessionId);
  }

  hasActiveRun(): boolean {
    return this.activeRuns.size > 0;
  }

  getRecoverableRun(session: Session): {
    runId: string;
    eventStart: number;
    eventId: number;
    running: boolean;
  } | null {
    const marker = readRunMarker(session.metadata);
    if (!marker) return null;
    const active = this.activeRuns.get(session.id);
    return {
      runId: marker.runId,
      eventStart: marker.eventStart,
      eventId: active?.runId === marker.runId
        ? Math.max(
            this.getLatestEventId(session.id),
            session.events.length - marker.eventStart,
          )
        : Math.max(0, session.events.length - marker.eventStart),
      running: active?.runId === marker.runId,
    };
  }

  getProjectStore() {
    return this.projectStore;
  }

  async resolveProjectWorkingDirectory(projectId?: string, requirePath = false): Promise<string> {
    if (!projectId) return this.workingDirectory;
    const project = await this.projectStore.get(projectId);
    if (!project) {
      throw new ProjectWorkingDirectoryError("项目不存在", "PROJECT_NOT_FOUND", 404);
    }
    if (!project.description?.trim()) {
      if (!requirePath) return this.workingDirectory;
      throw new ProjectWorkingDirectoryError("该项目没有宿主机目录", "PROJECT_PATH_REQUIRED", 400);
    }
    try {
      const policy = HostPathPolicy.fromEnvironment(process.env.AGENT_WEB_ROOTS, homedir());
      return policy.assertDirectory(project.description);
    } catch (error) {
      throw new ProjectWorkingDirectoryError(
        error instanceof Error ? error.message : "项目目录不可用",
        "PROJECT_PATH_INVALID",
        400,
      );
    }
  }

  /** Active model info for display (never exposes the key). */
  getModelConfig() {
    return {
      provider: (process.env.AGENT_MODEL_PROVIDER || "openai") as string,
      modelId: process.env.AGENT_MODEL_ID || "gpt-4o",
      baseUrl: process.env.AGENT_BASE_URL || "",
    };
  }

  getWebAppBuildId() {
    return (globalThis as typeof globalThis & { __webAppBuildId?: string }).__webAppBuildId ?? "";
  }

  registerRemoteTools(projectId: string, tools: RemoteToolRegistration[]) {
    return this.remoteToolStore.upsertTools(projectId, tools);
  }

  getRemoteToolStore() {
    return this.remoteToolStore;
  }

  async createSession(title: string, projectId = ""): Promise<Session> {
    const now = new Date().toISOString();

    if (projectId) {
      const project = await this.projectStore.get(projectId);
      if (!project) {
        await this.projectStore.create({
          id: projectId,
          name: projectId,
          description: "",
          created: now,
          updated: now,
        });
      }
    }

    return this.sessionStore.create({
      id: crypto.randomUUID(),
      projectId,
      title,
      status: "idle",
      messages: [],
      events: [],
      created: now,
      updated: now,
      metadata: withPendingAutoTitle(title, { permissionMode: "full-access" }),
    });
  }

  async setSessionPermissionMode(sessionId: string, mode: ToolPermissionMode): Promise<Session> {
    if (!isToolPermissionMode(mode)) throw new Error(`Invalid permission mode: ${String(mode)}`);
    const session = await this.sessionStore.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    this.toolPermissionGate.clearSession(sessionId);
    return this.sessionStore.update(sessionId, {
      metadata: { ...session.metadata, permissionMode: mode },
    });
  }

  getLatestEventId(sessionId: string): number {
    return this.eventCounters.get(sessionId) ?? 0;
  }

  subscribe(sessionId: string, fn: (event: AgentEvent, id: number) => void, lastEventId = -1): () => void {
    // Replay buffered events the subscriber missed (late attach after the run
    // already failed, or EventSource auto-reconnect mid-run). Subscribers pass
    // the last SSE id they saw; only newer buffered events are flushed.
    const buffer = this.recentEvents.get(sessionId) ?? [];
    let deliveredEventId = lastEventId;
    for (const entry of buffer) {
      if (entry.id <= deliveredEventId) continue;
      try {
        fn(entry.event, entry.id);
        deliveredEventId = entry.id;
      } catch { /* ignore */ }
    }
    const subscriber = (event: AgentEvent, id: number) => {
      if (id <= deliveredEventId) return;
      try {
        fn(event, id);
        deliveredEventId = id;
      } catch { /* ignore */ }
    };
    const subscribers = this.subscribers.get(sessionId) ?? new Set<(event: AgentEvent, id: number) => void>();
    subscribers.add(subscriber);
    this.subscribers.set(sessionId, subscribers);
    return () => {
      subscribers.delete(subscriber);
      if (subscribers.size === 0) this.subscribers.delete(sessionId);
    };
  }

  private emit(sessionId: string, event: AgentEvent): void {
    const id = (this.eventCounters.get(sessionId) ?? 0) + 1;
    this.eventCounters.set(sessionId, id);
    const buffer = this.recentEvents.get(sessionId);
    if (buffer) {
      buffer.push({ id, event });
      if (buffer.length > 500) buffer.splice(0, buffer.length - 500);
    }
    for (const fn of this.subscribers.get(sessionId) ?? []) {
      try { fn(event, id); } catch { /* ignore */ }
    }
  }

  /**
   * Push an event from an external native runtime (Codex / Claude Code) into
   * the SSE bus. Native history stays in the runtime's own storage — nothing
   * is persisted to SQLite here.
   */
  publishExternal(sessionId: string, event: AgentEvent): void {
    this.emit(sessionId, event);
  }

  /** Restart the event sequence for a native session before a new run. */
  resetExternalStream(sessionId: string): void {
    this.eventCounters.set(sessionId, 0);
    this.recentEvents.set(sessionId, []);
  }

  private projectMessagesFromEvents(events: AgentEvent[]): Message[] {
    const messages: Message[] = [];
    let streamingAssistant: Message | null = null;

    for (const event of events) {
      if (event.type === "text_chunk") {
        if (!streamingAssistant) {
          streamingAssistant = { role: "assistant", content: "" };
          messages.push(streamingAssistant);
        }
        streamingAssistant.content += event.text;
        continue;
      }

      if (event.type === "tool_call") {
        if (streamingAssistant && !streamingAssistant.toolCalls) {
          streamingAssistant.toolCalls = [event.toolCall];
        } else {
          messages.push({ role: "assistant", content: "", toolCalls: [event.toolCall] });
        }
        streamingAssistant = null;
        continue;
      }

      if (event.type === "tool_result") {
        messages.push({
          role: "tool",
          content: event.result.content,
          toolCallId: event.result.toolCallId,
        });
        continue;
      }

      if ((event as { type?: string }).type === "ask_user") {
        messages.push({
          role: "assistant",
          content: "",
        } as Message);
        streamingAssistant = null;
        continue;
      }

      if (event.type === "done") {
        const completionDurationMs = typeof event.durationMs === "number"
          && Number.isFinite(event.durationMs)
          && event.durationMs >= 0
          ? event.durationMs
          : undefined;
        if (streamingAssistant) {
          streamingAssistant.content = event.finalText || streamingAssistant.content;
          if (completionDurationMs !== undefined) {
            streamingAssistant.presentation = {
              ...streamingAssistant.presentation,
              completionDurationMs,
            };
          }
        } else if (event.finalText?.trim()) {
          messages.push({
            role: "assistant",
            content: event.finalText,
            ...(completionDurationMs === undefined
              ? {}
              : { presentation: { completionDurationMs } }),
          });
        }
        streamingAssistant = null;
      }
    }

    return messages;
  }

  startRun(input: string, sessionId: string, images?: string[]): {
    runId: string;
    completion: Promise<void>;
  } {
    if (this.activeRuns.has(sessionId)) {
      throw new CustomerAgentRunConflictError(sessionId);
    }

    const runId = crypto.randomUUID();
    this.activeRuns.set(sessionId, { runId, agent: null });
    const completion = this.executeRun(input, sessionId, runId, images).finally(() => {
      if (this.activeRuns.get(sessionId)?.runId === runId) {
        this.activeRuns.delete(sessionId);
      }
    });
    return { runId, completion };
  }

  async run(input: string, sessionId: string, images?: string[]): Promise<void> {
    await this.startRun(input, sessionId, images).completion;
  }

  private async executeRun(
    input: string,
    sessionId: string,
    runId: string,
    images?: string[],
  ): Promise<void> {
    const runStartedAt = performance.now();
    let session = await this.sessionStore.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const staleMarker = readRunMarker(session.metadata);
    if (staleMarker && staleMarker.runId !== runId) {
      await this.commitRun(sessionId, staleMarker, "failed");
      session = await this.sessionStore.get(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
    }
    const runWorkingDirectory = await this.resolveProjectWorkingDirectory(session?.projectId);
    await this.sessionStore.consumePendingAutoTitle(sessionId, input);
    session = await this.sessionStore.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const marker: CustomerAgentRunMarker = {
      runId,
      eventStart: session.events.length,
      startedAt: new Date().toISOString(),
    };
    const presentation = sentImagePresentation(images);
    await this.appendMessagesAndUpdate(sessionId, [{
      role: "user",
      content: input,
      ...(presentation ? { presentation } : {}),
    }], {
      status: "active",
      metadata: { ...session.metadata, [ACTIVE_RUN_METADATA_KEY]: marker },
    });
    // a fresh run restarts the event sequence; late subscribers replay only it
    this.eventCounters.set(sessionId, 0);
    this.recentEvents.set(sessionId, []);
    const runProjectId = session?.projectId || this.defaultRemoteToolsProjectId;
    let agent: IAgentLoop;
    try {
      agent = await this.getBuilder()
        .withWorkingDirectory(runWorkingDirectory)
        .withRemoteToolStore(this.remoteToolStore, runProjectId)
        .withTool(new AskUserTool(async (request: AskUserRequest) => {
          return this.createQuestion(request, sessionId);
        }))
        .build();
    } catch (err) {
      // Emit error to SSE subscribers so the SDK can display it
      const errorEvent = {
        type: "error",
        message: err instanceof Error ? err.message : "Failed to build agent",
      } as AgentEvent;
      try {
        await this.sessionStore.addEvent(sessionId, errorEvent);
        await this.commitRun(sessionId, marker, "failed");
      } catch {}
      this.emit(sessionId, errorEvent);
      throw err;
    } finally {
      this.builder
        ?.withWorkingDirectory(this.workingDirectory)
        .withRemoteToolStore(this.remoteToolStore, this.defaultRemoteToolsProjectId);
    }

    const active = this.activeRuns.get(sessionId);
    if (!active || active.runId !== runId) return;
    active.agent = agent;
    const activeRun = agent.run(input, sessionId, images);
    let runFailed = false;
    let terminalCommitted = false;

    try {
      for await (const event of activeRun) {
        const emittedEvent: AgentEvent = event.type === "done" && !runFailed
          ? {
              ...event,
              durationMs: Math.max(0, Math.round(performance.now() - runStartedAt)),
            }
          : event;
        await this.sessionStore.addEvent(sessionId, emittedEvent);

        if (emittedEvent.type === "error") {
          runFailed = true;
          if (!terminalCommitted) {
            await this.commitRun(sessionId, marker, "failed");
            terminalCommitted = true;
          }
        } else if (emittedEvent.type === "turn_aborted") {
          if (!terminalCommitted) {
            await this.commitRun(sessionId, marker, "aborted");
            terminalCommitted = true;
          }
        } else if (emittedEvent.type === "done" && !terminalCommitted) {
          await this.commitRun(sessionId, marker, runFailed ? "failed" : "completed");
          terminalCommitted = true;
        }

        this.emit(sessionId, emittedEvent);
      }
    } catch (err) {
      // The loop itself threw (not an in-band error event) — without this the
      // subscriber would wait forever with no feedback.
      runFailed = true;
      const errorEvent = {
        type: "error",
        message: err instanceof Error ? err.message : "Agent run failed",
      } as AgentEvent;
      try {
        await this.sessionStore.addEvent(sessionId, errorEvent);
        if (!terminalCommitted) {
          await this.commitRun(sessionId, marker, "failed");
          terminalCommitted = true;
        }
      } catch {}
      this.emit(sessionId, errorEvent);
    }

    if (!terminalCommitted) {
      const errorEvent = { type: "error", message: "Agent run ended without a terminal event" } as AgentEvent;
      try {
        await this.sessionStore.addEvent(sessionId, errorEvent);
        await this.commitRun(sessionId, marker, "failed");
      } catch {}
      this.emit(sessionId, errorEvent);
    }
  }

  private async commitRun(
    sessionId: string,
    marker: CustomerAgentRunMarker,
    status: Session["status"],
  ): Promise<void> {
    const stored = await this.sessionStore.get(sessionId);
    if (!stored) return;
    const currentMarker = readRunMarker(stored.metadata);
    if (!currentMarker || currentMarker.runId !== marker.runId) return;

    const metadata = { ...stored.metadata };
    delete metadata[ACTIVE_RUN_METADATA_KEY];
    const projected = this.projectMessagesFromEvents(stored.events.slice(marker.eventStart));
    await this.appendMessagesAndUpdate(sessionId, projected, { status, metadata });
  }

  private async appendMessagesAndUpdate(
    sessionId: string,
    messages: Message[],
    update: Pick<Partial<Session>, "status" | "metadata">,
  ): Promise<void> {
    const database = getDatabase(this.baseDir).db;
    const insert = database.prepare(
      "INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, presentation, timestamp) VALUES (?,?,?,?,?,?,?,?)",
    );
    const transaction = database.transaction(() => {
      const row = database.prepare("SELECT status, metadata FROM sessions WHERE id = ?").get(sessionId) as
        | { status: Session["status"]; metadata: string }
        | undefined;
      if (!row) throw new Error(`Session not found: ${sessionId}`);

      const timestamp = Date.now();
      messages.forEach((message, index) => {
        insert.run(
          sessionId,
          message.role,
          message.content ?? "",
          JSON.stringify(message.toolCalls ?? []),
          message.toolCallId ?? null,
          message.name ?? null,
          message.presentation ? JSON.stringify(message.presentation) : null,
          timestamp + index,
        );
      });
      database.prepare("UPDATE sessions SET status = ?, updated = ?, metadata = ? WHERE id = ?").run(
        update.status ?? row.status,
        new Date().toISOString(),
        JSON.stringify(update.metadata ?? JSON.parse(row.metadata)),
        sessionId,
      );
    });
    transaction();
  }

  /** Create a pending question and emit ask_user event to SSE subscribers */
  private async createQuestion(
    request: AskUserRequest,
    sessionId: string,
  ): Promise<AskUserResponse> {
    const questionId = crypto.randomUUID();
    const event = {
      type: "ask_user" as any,
      ...({
        questionId,
        question: request.question,
        options: request.options,
        multiSelect: request.multiSelect,
      } as any),
    } as AgentEvent;
    const response = new Promise<AskUserResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingQuestions.has(questionId)) {
          this.pendingQuestions.delete(questionId);
          reject(new Error("Question timed out after 5 minutes"));
        }
      }, 5 * 60 * 1000);
      this.pendingQuestions.set(questionId, { resolve, reject, timer, sessionId });
    });
    await this.sessionStore.addEvent(sessionId, event);
    this.emit(sessionId, event);
    return response;
  }

  /** Resolve a pending question — called from /api/agent/answer */
  answerQuestion(
    questionId: string,
    answer: string,
    selectedIndices?: number[],
  ): boolean {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingQuestions.delete(questionId);
    pending.resolve({ answer, selectedIndices });
    return true;
  }

  /**
   * Inject a user message into a running agent loop (picked up on the next
   * iteration via the __steer__ mailbox, same protocol as desktop).
   * Returns false when no run is active for this session — the caller
   * should start a new run instead.
   */
  async steer(input: string, sessionId: string): Promise<boolean> {
    await this.sessionStore.addMessage(sessionId, {
      role: "user",
      content: input,
      name: "__steer__",
    } as Message);
    if (this.activeRuns.get(sessionId)?.agent) {
      this.emit(sessionId, { type: "thinking", message: `User added: ${input.slice(0, 60)}` } as AgentEvent);
      return true;
    }
    return false;
  }

  abort(sessionId?: string): void {
    if (sessionId) this.activeRuns.get(sessionId)?.agent?.abort();
    else for (const run of this.activeRuns.values()) run.agent?.abort();
    for (const [questionId, pending] of this.pendingQuestions) {
      if (sessionId && pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error("Agent aborted"));
      this.pendingQuestions.delete(questionId);
    }
  }
}

const globalWithAgentHost = globalThis as typeof globalThis & { __agentHost?: AgentHost };

export const agentHost = globalWithAgentHost.__agentHost ?? new AgentHost();
globalWithAgentHost.__agentHost = agentHost;
