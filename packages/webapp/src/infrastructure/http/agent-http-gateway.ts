import type {
  AgentApi,
  AgentDefinition,
  CronTask,
  LSPServerConfig,
  MCPServer,
  SessionGoalState,
  SessionQueryIndex,
} from "../../domain/ports/agent-port";
import { HttpClient, listOf } from "./http-client";
import { LocalCollection } from "../local/local-collection";
import type { LocalSettingsRepository } from "../local/local-settings-repository";
import { StreamingThinkFilter, stripThinkBlocks } from "./think-filter";
import type { WebProjectBridge } from "../web-shell-project-bridge";

type EventListener = (event: unknown) => void;
type Unsubscribe = () => void;

interface NativeStreamCursor {
  runId?: string;
  sequence: number;
}

interface BufferedStreamText {
  event: Record<string, unknown>;
  timer: ReturnType<typeof setTimeout>;
}

const TRANSPORT_FAILURE = /^(?:load failed|failed to fetch|network request failed|networkerror when attempting to fetch resource\.?|the network connection was lost\.?|fetch failed)$/i;
const CODEX_COMMENTARY_FRAME_MS = 50;

function isTransportFailure(error: unknown): boolean {
  return error instanceof Error
    && error.name !== "AbortError"
    && TRANSPORT_FAILURE.test(error.message.trim());
}

/** Subset of the port the web gateway intentionally leaves to browser fallbacks. */
type BrowserHandled = "wakeStart" | "dictationStart" | "dictationStop" | "onDictation" | "onDictationError";

/**
 * Browser adapter for the AgentApi port (DDD ports & adapters).
 *
 * Reuses the server's capabilities over HTTP/SSE:
 *   /api/agent/{run,stream,abort,steer,answer}  — runs, streaming, steering
 *   /api/sessions                               — session persistence
 *   /api/memory, /api/skills, /api/mcp/*        — memory/skills/MCP catalogs
 *
 * Desktop IPC semantics reproduced for the shared UI:
 *   - run() resolves only when the whole run settles;
 *   - events are fanned out through the persistent onEvent bus, stamped with
 *     the `_sid` session tag the renderer routes by;
 *   - ordinary runs open SSE before admission; native runs admit first and
 *     replay from their persisted pre-run cursor, avoiding mobile connection
 *     limits without losing early events.
 *
 * Voice wake/dictation are deliberately NOT implemented: the renderer's
 * lib/speech falls back to the Web Speech API when those bridge methods are
 * absent. TTS is reported unavailable ({ok:false}).
 */
export class AgentHttpGateway {
  private readonly streams = new Map<string, EventSource>();
  private readonly nativeStreamCursors = new Map<string, NativeStreamCursor>();
  private readonly pendingRuns = new Map<string, () => void>();
  private readonly listeners = new Set<EventListener>();
  private readonly thinkFilters = new Map<string, StreamingThinkFilter>();
  private readonly bufferedStreamText = new Map<string, BufferedStreamText>();

  private readonly agentDefs = new LocalCollection<AgentDefinition>("webapp.agentDefs");
  private readonly lspServers = new LocalCollection<LSPServerConfig>("webapp.lspServers");
  private readonly uploads = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly http: HttpClient,
    private readonly settings: LocalSettingsRepository,
    private readonly projectBridge?: WebProjectBridge,
  ) {}

  private requireProjectBridge(): WebProjectBridge {
    if (this.projectBridge) return this.projectBridge;
    throw Object.assign(
      new Error("请从 AgentRoam Web 控制台打开项目"),
      { code: "WEB_SHELL_REQUIRED" },
    );
  }

  // ── Agent control ──────────────────────────────────────────────────────

  onEvent(callback: EventListener): Unsubscribe {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  async run(
    input: string,
    sessionId: string,
    _agentIds?: string[],
    _agentName?: string,
    images?: string[],
    nativeOptions?: { model?: { id: string; providerID?: string }; reasoningEffort?: string },
  ): Promise<unknown[]> {
    const isNativeSession = sessionId.startsWith("runtime:");
    const hadStream = this.streams.has(sessionId);
    const hadPendingRun = this.pendingRuns.has(sessionId);
    const nativeCursorBeforeRun = this.nativeStreamCursors.get(sessionId);
    let pendingResolve: (() => void) | null = null;
    let finished: Promise<void> | null = null;
    try {
      if (!isNativeSession) {
        await this.openStream(sessionId, this.nativeStreamCursors.get(sessionId));
      }
      finished = hadPendingRun
        ? null
        : new Promise<void>((resolve) => {
            pendingResolve = resolve;
            this.pendingRuns.set(sessionId, resolve);
          });
      // A user-configured model profile travels with the run; without one the
      // server keeps using its own env configuration.
      const model = this.settings.getModelOverride();
      const limits = this.settings.getRunLimits();
      const started = await this.http.post<{ runId?: string; snapshotRevision?: number }>("/api/agent/run", {
        input,
        sessionId,
        ...(images?.length ? { images } : {}),
        ...(model ? { model } : {}),
        reasoningEffort: this.settings.getReasoningEffort(),
        maxIterations: limits.maxIterations,
        maxTokens: limits.maxTokens,
        ...(nativeOptions?.model?.id ? { nativeModel: nativeOptions.model } : {}),
        ...(nativeOptions?.reasoningEffort ? { nativeReasoningEffort: nativeOptions.reasoningEffort } : {}),
      });
      if (isNativeSession) {
        const streamCursor = typeof started.runId === "string"
          && nativeCursorBeforeRun?.runId !== started.runId
          ? { sequence: 0, runId: started.runId }
          : nativeCursorBeforeRun ?? {
              sequence: 0,
              ...(typeof started.runId === "string" ? { runId: started.runId } : {}),
            };
        await this.openStream(
          sessionId,
          streamCursor,
          { waitForOpen: false },
        );
      }
      this.dispatch(sessionId, {
        type: "run_admitted",
        ...(typeof started.runId === "string" ? { _nativeRunId: started.runId } : {}),
      });
      if (finished) await finished;
    } catch (err) {
      const recoveredCursor = !hadPendingRun && isNativeSession && isTransportFailure(err)
        ? await this.recoverNativeAdmission(sessionId, nativeCursorBeforeRun)
        : null;
      if (
        recoveredCursor
      ) {
        await this.openStream(
          sessionId,
          recoveredCursor,
          { waitForOpen: false },
        );
        if (finished) await finished;
        return [];
      }
      const reportedCode = (err as { code?: unknown }).code;
      const code = typeof reportedCode === "string"
        ? reportedCode
        : (err as { status?: number }).status === 409
          ? "SESSION_OCCUPIED"
          : undefined;
      if (isNativeSession && code === "SESSION_ALREADY_RUNNING") {
        await this.openStream(
          sessionId,
          nativeCursorBeforeRun ?? { sequence: 0 },
          { waitForOpen: false },
        );
      }
      const preserveActiveRun = hadStream || hadPendingRun || code === "SESSION_ALREADY_RUNNING";
      this.dispatch(sessionId, {
        type: "error",
        message: isTransportFailure(err)
          ? "网络连接中断，消息未确认发送，请重试"
          : err instanceof Error ? err.message : "无法启动运行",
        ...(code ? { code } : {}),
        ...(preserveActiveRun ? { _preserveActiveRun: true } : {}),
      });
      // A refresh can already be following the active run when the user
      // retries a send. Keep that stream and its original completion promise
      // intact; admission has failed, but the prior turn is still valid.
      if (!preserveActiveRun) {
        this.closeStream(sessionId);
        this.settle(sessionId);
      } else if (pendingResolve && this.pendingRuns.get(sessionId) === pendingResolve) {
        // This attempt created no native run, so it must not replace or leave
        // behind a completion promise for the already-followed turn.
        this.pendingRuns.delete(sessionId);
      }
    }
    return [];
  }

  private async recoverNativeAdmission(
    sessionId: string,
    previousCursor?: NativeStreamCursor,
  ): Promise<NativeStreamCursor | null> {
    const observedCursor = this.nativeStreamCursors.get(sessionId);
    if (observedCursor?.runId && observedCursor.runId !== previousCursor?.runId) {
      this.dispatchRecoveredAdmission(sessionId, observedCursor);
      return observedCursor;
    }
    try {
      const detail = await this.http.get<{
        status?: string;
        snapshotRevision?: number;
        snapshotRunId?: string | null;
      }>(`/api/sessions/${encodeURIComponent(sessionId)}?limit=1`);
      const runId = typeof detail.snapshotRunId === "string" ? detail.snapshotRunId : undefined;
      const sequence = typeof detail.snapshotRevision === "number" ? detail.snapshotRevision : 0;
      const isNewRun = Boolean(runId && previousCursor?.runId && runId !== previousCursor.runId);
      const isFirstObservedActiveRun = Boolean(
        runId && !previousCursor?.runId && detail.status === "running",
      );
      if (!isNewRun && !isFirstObservedActiveRun) return null;

      this.dispatchRecoveredAdmission(sessionId, { runId, sequence });
      return { runId: runId!, sequence: 0 };
    } catch {
      return null;
    }
  }

  private dispatchRecoveredAdmission(sessionId: string, cursor: NativeStreamCursor): void {
    this.dispatch(sessionId, {
      type: "run_admitted",
      ...(cursor.runId ? { _nativeRunId: cursor.runId } : {}),
    });
  }

  async steer(input: string, sessionId: string, _agentName?: string): Promise<boolean> {
    const res = await this.http.post<{ steered: boolean }>("/api/agent/steer", { input, sessionId });
    if (!res.steered) {
      // No active run for this session — mirror desktop: start a new run.
      void this.run(input, sessionId).catch(() => {});
    }
    return true;
  }

  async steerSessionMessage(id: string, messageId: string): Promise<SessionGoalState> {
    const result = await this.http.post<{ steered: boolean; state: SessionGoalState }>("/api/agent/steer", {
      sessionId: id,
      messageId,
    });
    if (!result.steered) throw new Error("当前运行不支持插队消息");
    return result.state;
  }

  async abort(sessionId?: string): Promise<void> {
    try {
      await this.http.post("/api/agent/abort", sessionId ? { sessionId } : {});
    } finally {
      // Aborted loops may not emit a terminal event — settle everything so
      // the renderer never stays stuck in "running".
      for (const sessionId of [...this.pendingRuns.keys()]) this.settle(sessionId);
      for (const sessionId of [...this.streams.keys()]) this.closeStream(sessionId);
    }
  }

  async answerQuestion(questionId: string, answer: string, selectedIndices?: number[]): Promise<boolean> {
    try {
      await this.http.post("/api/agent/answer", { questionId, answer, selectedIndices });
      return true;
    } catch {
      return false;
    }
  }

  // ── Sessions ───────────────────────────────────────────────────────────

  async listSessions(projectId?: string): Promise<unknown[]> {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    return this.http.get<unknown[]>(`/api/sessions${query}`);
  }

  async listAgentWorkspaces(
    agentType: string,
    query: { cursor?: string | null; limit?: number; refresh?: boolean; since?: string | null } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams({ agentType });
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.refresh) params.set("refresh", "1");
    if (query.since) params.set("since", query.since);
    return this.http.get(`/api/agent-workspaces?${params.toString()}`);
  }

  async importAgentWorkspace(agentType: string, path: string, name?: string): Promise<unknown> {
    return this.http.post("/api/agent-workspaces", {
      agentType,
      path,
      ...(name ? { name } : {}),
    });
  }

  async listAgentWorkspaceSessions(
    agentType: string,
    workspaceId: string,
    query: { cursor?: string | null; limit?: number; refresh?: boolean } = {},
  ): Promise<unknown> {
    const params = new URLSearchParams({ agentType });
    if (query.cursor) params.set("cursor", query.cursor);
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.refresh) params.set("refresh", "1");
    return this.http.get(`/api/agent-workspaces/${encodeURIComponent(workspaceId)}/sessions?${params.toString()}`);
  }

  async refreshSessions(projectId?: string): Promise<unknown[]> {
    // Forces native runtime rediscovery (occupancy / status freshness).
    const query = projectId
      ? `?refresh=1&projectId=${encodeURIComponent(projectId)}`
      : "?refresh=1";
    return this.http.get<unknown[]>(`/api/sessions${query}`);
  }

  async listChildSessions(_parentId: string): Promise<unknown[]> {
    // The server host builds no sub-agents — no child sessions exist.
    return [];
  }

  async getSession(
    id: string,
    query?: { before?: string; after?: string; anchor?: string; limit?: number; view?: "core" | "trace"; revision?: string; turnId?: string },
  ): Promise<unknown> {
    try {
      const params = new URLSearchParams();
      if (query?.before) params.set("before", query.before);
      if (query?.after) params.set("after", query.after);
      if (query?.anchor) params.set("anchor", query.anchor);
      if (query?.limit !== undefined) params.set("limit", String(query.limit));
      if (query?.view) params.set("view", query.view);
      if (query?.revision) params.set("revision", query.revision);
      if (query?.turnId) params.set("turnId", query.turnId);
      const suffix = params.size > 0 ? `?${params.toString()}` : "";
      const session = await this.http.get<Record<string, unknown>>(
        `/api/sessions/${encodeURIComponent(id)}${suffix}`,
      );
      // Stored history may contain reasoning tags — strip before display.
      if (Array.isArray(session.messages)) {
        session.messages = (session.messages as Array<Record<string, unknown>>).map((m) =>
          typeof m.content === "string" ? { ...m, content: stripThinkBlocks(m.content) } : m,
        );
      }
      if (Array.isArray(session.events)) {
        session.events = (session.events as Array<Record<string, unknown>>).map((e) => {
          if (typeof e.text === "string" && e.text.includes("<think>")) return { ...e, text: stripThinkBlocks(e.text) };
          if (typeof e.finalText === "string" && e.finalText.includes("<think>")) return { ...e, finalText: stripThinkBlocks(e.finalText) };
          return e;
        });
      }
      if (id.startsWith("runtime:") && typeof session.snapshotRevision === "number") {
        const snapshotRunId = typeof session.snapshotRunId === "string"
          ? session.snapshotRunId
          : undefined;
        const history = session.history as { delivery?: unknown } | undefined;
        const progressive = history?.delivery === "core" || history?.delivery === "trace";
        if (!progressive) {
          this.rememberNativeStreamCursor(id, session.snapshotRevision, snapshotRunId);
        }
        if (session.status === "running" && session.occupancy !== "owned-externally") {
          const rememberedCursor = this.nativeStreamCursors.get(id);
          const cursor = progressive && snapshotRunId && rememberedCursor?.runId !== snapshotRunId
            ? { sequence: 0, runId: snapshotRunId }
            : rememberedCursor
              ?? (progressive ? { sequence: 0, ...(snapshotRunId ? { runId: snapshotRunId } : {}) } : undefined);
          void this.openStream(id, cursor).catch(() => undefined);
        }
      } else if (!id.startsWith("runtime:") && session.status === "active") {
        const activeRun = session.activeRun as { eventId?: unknown; running?: unknown } | undefined;
        if (activeRun?.running === true && typeof activeRun.eventId === "number") {
          void this.openStream(id, { sequence: activeRun.eventId }).catch(() => undefined);
        }
      }
      return session;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async getSessionToolResult(
    id: string,
    ref: { turnId: string; itemId: string; revision: string },
  ): Promise<unknown> {
    const params = new URLSearchParams(ref);
    return this.http.get(
      `/api/sessions/${encodeURIComponent(id)}/tool-result?${params.toString()}`,
    );
  }

  async getSessionQueryIndex(id: string): Promise<SessionQueryIndex> {
    return this.http.get<SessionQueryIndex>(
      `/api/sessions/${encodeURIComponent(id)}/query-index`,
    );
  }

  observeSession(
    id: string,
    callback: (change: { type: "session_history_changed"; revision: number }) => void,
    onError?: () => void,
  ): Unsubscribe {
    const source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/changes`);
    let closed = false;
    source.onmessage = (message) => {
      if (!message.data) return;
      try {
        const change = JSON.parse(message.data) as { type?: string; revision?: unknown };
        if (change.type === "session_history_changed" && typeof change.revision === "number") {
          callback({ type: change.type, revision: change.revision });
        }
      } catch {
        // Ignore malformed events; a later valid revision will refresh the tail.
      }
    };
    source.onerror = () => {
      if (closed) return;
      closed = true;
      source.close();
      onError?.();
    };
    return () => {
      if (closed) return;
      closed = true;
      source.close();
    };
  }

  async setSessionPermissionMode(
    id: string,
    mode: "request-approval" | "auto-approval" | "full-access",
  ): Promise<unknown> {
    return this.http.patch(`/api/sessions/${encodeURIComponent(id)}`, { permissionMode: mode });
  }

  async getSessionGoals(id: string): Promise<SessionGoalState> {
    const state = await this.http.get<SessionGoalState>(`/api/sessions/${encodeURIComponent(id)}/goals`);
    if (state.active) void this.openStream(id, this.nativeStreamCursors.get(id)).catch(() => undefined);
    return state;
  }

  async enqueueSessionGoal(id: string, objective: string, sourceMessageId?: string): Promise<SessionGoalState> {
    await this.openStream(id, this.nativeStreamCursors.get(id));
    const result = await this.http.post<{
      state: SessionGoalState;
      started?: { runId?: string; snapshotRevision?: number };
    }>(`/api/sessions/${encodeURIComponent(id)}/goals`, { objective, sourceMessageId });
    if (typeof result.started?.snapshotRevision === "number") {
      this.dispatch(id, {
        type: "run_admitted",
        ...(result.started.runId ? { _nativeRunId: result.started.runId } : {}),
      });
    }
    return result.state;
  }

  async reorderSessionGoals(id: string, orderedIds: string[]): Promise<SessionGoalState> {
    return this.http.patch(`/api/sessions/${encodeURIComponent(id)}/goals`, { orderedIds });
  }

  async cancelSessionGoal(id: string, goalId: string): Promise<SessionGoalState> {
    return this.http.delete(`/api/sessions/${encodeURIComponent(id)}/goals?goalId=${encodeURIComponent(goalId)}`);
  }

  async enqueueSessionMessage(
    id: string,
    message: { sourceMessageId: string; content: string; images?: string[]; agentIds?: string[]; agentName?: string },
  ): Promise<SessionGoalState> {
    await this.openStream(id, this.nativeStreamCursors.get(id));
    const result = await this.http.post<{
      state: SessionGoalState;
      started?: { runId?: string; snapshotRevision?: number };
    }>(`/api/sessions/${encodeURIComponent(id)}/goals`, {
      kind: "message",
      objective: message.content,
      sourceMessageId: message.sourceMessageId,
      messagePayload: {
        images: message.images,
        agentIds: message.agentIds,
        agentName: message.agentName,
      },
    });
    if (typeof result.started?.snapshotRevision === "number") {
      this.dispatch(id, {
        type: "run_admitted",
        ...(result.started.runId ? { _nativeRunId: result.started.runId } : {}),
      });
    }
    return result.state;
  }

  async updateSessionMessage(id: string, messageId: string, content: string): Promise<SessionGoalState> {
    return this.http.patch(`/api/sessions/${encodeURIComponent(id)}/goals`, {
      kind: "message",
      messageId,
      objective: content,
    });
  }

  async reorderSessionMessages(id: string, orderedIds: string[]): Promise<SessionGoalState> {
    return this.http.patch(`/api/sessions/${encodeURIComponent(id)}/goals`, {
      kind: "message",
      orderedIds,
    });
  }

  async cancelSessionMessage(id: string, messageId: string): Promise<SessionGoalState> {
    return this.http.delete(
      `/api/sessions/${encodeURIComponent(id)}/goals?kind=message&goalId=${encodeURIComponent(messageId)}`,
    );
  }

  async createSession(title: string, projectId?: string, agentType?: string, cwd?: string): Promise<unknown> {
    return this.http.post("/api/sessions", {
      title,
      ...(projectId ? { projectId } : {}),
      ...(agentType && agentType !== "customer-agent" ? { agentType } : {}),
      ...(cwd ? { cwd } : {}),
    });
  }

  async forkSession(id: string): Promise<unknown> {
    return this.http.post(`/api/sessions/${encodeURIComponent(id)}/fork`, {});
  }

  async releaseCodexSession(id: string): Promise<void> {
    await this.http.post(`/api/sessions/${encodeURIComponent(id)}/release`, {});
  }

  async deleteSession(id: string): Promise<void> {
    await this.http.delete(`/api/sessions/${encodeURIComponent(id)}`);
  }

  async getRuntimeHealth(): Promise<unknown[]> {
    return this.http.get<unknown[]>("/api/agent/runtime-health");
  }

  getUpdateStatus() {
    return this.http.get<import("../../../../desktop/renderer/global").UpdateStatus>("/api/update/status");
  }

  checkForUpdate() {
    return this.http.post<import("../../../../desktop/renderer/global").UpdateStatus>("/api/update/check", {});
  }

  installUpdate() {
    return this.http.post<import("../../../../desktop/renderer/global").UpdateStatus>("/api/update/install", {});
  }

  onUpdateStatus(_callback: (status: import("../../../../desktop/renderer/global").UpdateStatus) => void): Unsubscribe {
    return () => undefined;
  }

  async listAgentModels(agentType: string): Promise<{ agentType: string; models: unknown[]; supported?: boolean }> {
    return this.http.get(`/api/agent/models?agentType=${encodeURIComponent(agentType)}`);
  }

  // ── Host projects (brokered through the parent WebSocket) ─────────────

  async listProjects(): Promise<unknown[]> {
    if (!this.projectBridge) return this.http.get<unknown[]>("/api/projects");
    const result = await this.requireProjectBridge().request<{ projects: unknown[] }>("project:list");
    return result.projects ?? [];
  }

  async getProject(id: string): Promise<unknown> {
    if (!this.projectBridge) return this.http.get(`/api/projects/${encodeURIComponent(id)}`);
    const result = await this.requireProjectBridge().request<{ project: unknown }>("project:get", { projectId: id });
    return result.project ?? null;
  }

  async createProject(name: string, description?: string): Promise<unknown> {
    if (!this.projectBridge) {
      return this.http.post("/api/projects", { name, path: description ?? "" });
    }
    const result = await this.requireProjectBridge().request<{ project: unknown }>("project:create", {
      name,
      path: description ?? "",
    });
    return result.project;
  }

  async updateProject(id: string, update: Record<string, unknown>): Promise<unknown> {
    if (!this.projectBridge) {
      return this.http.patch(`/api/projects/${encodeURIComponent(id)}`, update);
    }
    const result = await this.requireProjectBridge().request<{ project: unknown }>("project:rename", {
      projectId: id,
      name: update.name,
    });
    return result.project;
  }

  async deleteProject(id: string): Promise<void> {
    if (!this.projectBridge) {
      await this.http.delete(`/api/projects/${encodeURIComponent(id)}`);
      return;
    }
    await this.requireProjectBridge().request("project:delete", { projectId: id });
  }

  async checkProjectPath(path: string): Promise<boolean> {
    if (!this.projectBridge) {
      const result = await this.http.get<{ valid: boolean }>(`/api/projects/check?path=${encodeURIComponent(path)}`);
      return result.valid === true;
    }
    const result = await this.requireProjectBridge().request<{ valid: boolean }>("project:check", { path });
    return result.valid === true;
  }

  async listProjectRoots(): Promise<string[]> {
    if (!this.projectBridge) return this.http.get<string[]>("/api/projects/roots");
    const result = await this.requireProjectBridge().request<{ roots: string[] }>("project:roots");
    return result.roots ?? [];
  }

  async listProjectDirectories(path: string): Promise<Array<{
    name: string;
    path: string;
    kind: "directory" | "file";
    hasChildren: boolean;
  }>> {
    if (!this.projectBridge) {
      return this.http.get<Array<{
        name: string;
        path: string;
        kind: "directory" | "file";
        hasChildren: boolean;
      }>>(`/api/projects/directories?path=${encodeURIComponent(path)}`);
    }
    const result = await this.requireProjectBridge().request<{ entries: Array<{
      name: string;
      path: string;
      kind: "directory" | "file";
      hasChildren: boolean;
    }> }>("project:directories", { path });
    return result.entries ?? [];
  }

  async setProjectWorkingDir(path: string): Promise<{ ok: boolean; path: string }> {
    return { ok: true, path };
  }

  // ── Settings (localStorage-backed; server keeps model config in env) ──

  getSettings() {
    return this.settings.get();
  }

  async saveSettings(update: Record<string, unknown>): Promise<void> {
    this.settings.save(update);
  }

  async setActiveProfile(profileId: string): Promise<void> {
    this.settings.setActiveProfile(profileId);
  }

  /** Best-effort: surface the server's active model in the settings panel. */
  async refreshServerModel(): Promise<void> {
    try {
      const info = await this.http.get<{ provider?: string; modelId?: string; baseUrl?: string }>(
        "/api/agent/model",
      );
      this.settings.reflectServerModel(info);
    } catch {
      // server unreachable or older build without the route — keep local view
    }
  }

  // ── Memory (server-backed) ─────────────────────────────────────────────

  async listMemories(): Promise<unknown[]> {
    return listOf<unknown>(await this.http.get("/api/memory"), "entries", "memories", "items");
  }

  async searchMemories(query: string): Promise<unknown[]> {
    return listOf<unknown>(
      await this.http.get(`/api/memory?q=${encodeURIComponent(query)}`),
      "entries", "memories", "items",
    );
  }

  async getMemory(name: string): Promise<unknown> {
    try {
      return await this.http.get(`/api/memory/${encodeURIComponent(name)}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async setMemory(entry: Record<string, unknown>): Promise<void> {
    await this.http.post("/api/memory", entry);
  }

  async deleteMemory(name: string): Promise<void> {
    await this.http.delete(`/api/memory/${encodeURIComponent(name)}`);
  }

  // ── MCP (server-backed; probe/enabled not supported server-side yet) ──

  async mcpList(): Promise<MCPServer[]> {
    return listOf<MCPServer>(await this.http.get("/api/mcp/servers"), "servers", "items");
  }

  async mcpSave(server: Record<string, unknown>): Promise<void> {
    await this.http.post("/api/mcp/connect", server);
  }

  async mcpDelete(id: string): Promise<void> {
    await this.http.delete(`/api/mcp/disconnect?serverId=${encodeURIComponent(id)}`);
  }

  async mcpSetEnabled(): Promise<void> {
    // not supported server-side yet
  }

  async mcpProbe(server: Record<string, unknown>): Promise<Array<{ name: string; description: string }>> {
    try {
      const res = await this.http.post<{ tools?: Array<{ name: string; description: string }> }>(
        "/api/mcp/connect",
        server,
      );
      return res.tools ?? [];
    } catch {
      return [];
    }
  }

  // ── Skills (list from server; import opens a native picker on desktop) ──

  async listSkills(): Promise<unknown[]> {
    return listOf<unknown>(await this.http.get("/api/skills"), "skills", "items");
  }

  async saveSkill(): Promise<void> {
    // not supported server-side yet
  }

  async deleteSkill(): Promise<void> {
    // not supported server-side yet
  }

  async setSkillEnabled(): Promise<void> {
    // not supported server-side yet
  }

  async importSkill(): Promise<null> {
    return null;
  }

  // ── Agent definitions / LSP / uploads (local-only fallbacks) ──────────

  listAgentDefs(): Promise<AgentDefinition[]> {
    return Promise.resolve(this.agentDefs.list());
  }

  getAgentDef(id: string): Promise<AgentDefinition | null> {
    return Promise.resolve(this.agentDefs.list().find((def) => def.id === id) ?? null);
  }

  createAgentDef(data: Partial<AgentDefinition>): Promise<AgentDefinition> {
    const now = new Date().toISOString();
    const definition: AgentDefinition = {
      id: crypto.randomUUID(),
      name: data.name ?? "新智能体",
      description: data.description ?? "",
      systemPrompt: data.systemPrompt ?? "",
      contextPlaceholders: data.contextPlaceholders ?? [],
      capabilities: data.capabilities ?? { profileId: "", enabledTools: [], enabledSkills: [], enabledMCPServers: [] },
      maxIterations: data.maxIterations ?? 10,
      isDefault: data.isDefault ?? false,
      created: now,
      updated: now,
      ...data,
    };
    this.agentDefs.upsert(definition);
    return Promise.resolve(definition);
  }

  updateAgentDef(id: string, update: Partial<AgentDefinition>): Promise<AgentDefinition> {
    const updated = {
      ...this.agentDefs.list().find((def) => def.id === id),
      ...update,
      id,
      updated: new Date().toISOString(),
    } as AgentDefinition;
    this.agentDefs.upsert(updated);
    return Promise.resolve(updated);
  }

  async deleteAgentDef(id: string): Promise<void> {
    this.agentDefs.remove(id);
  }

  async setActiveAgentDef(id: string): Promise<{ activeAgentId?: string }> {
    this.agentDefs.list().forEach((def) => {
      this.agentDefs.upsert({ ...def, isDefault: def.id === id });
    });
    return { activeAgentId: id };
  }

  lspList(): Promise<LSPServerConfig[]> {
    return Promise.resolve(this.lspServers.list());
  }

  lspSave(config: Partial<LSPServerConfig> & { name: string }): Promise<void> {
    const entry = {
      id: config.id ?? crypto.randomUUID(),
      enabled: true,
      ...config,
    } as LSPServerConfig;
    this.lspServers.upsert(entry);
    return Promise.resolve();
  }

  async lspDelete(id: string): Promise<void> {
    this.lspServers.remove(id);
  }

  lspSetEnabled(id: string, enabled: boolean): Promise<void> {
    const found = this.lspServers.list().find((server) => server.id === id);
    if (found) this.lspServers.upsert({ ...found, enabled });
    return Promise.resolve();
  }

  listUploads(): Promise<unknown[]> {
    return Promise.resolve([...this.uploads.values()]);
  }

  getUpload(id: string): Promise<unknown> {
    return Promise.resolve(this.uploads.get(id) ?? null);
  }

  async saveUpload(entry: Record<string, unknown>): Promise<void> {
    const id = (entry.id as string) ?? crypto.randomUUID();
    this.uploads.set(id, { ...entry, id });
  }

  async deleteUpload(id: string): Promise<void> {
    this.uploads.delete(id);
  }

  // ── Cron (server scheduler not wired yet — placeholder tasks) ─────────

  async cronCreate(cron: string, prompt: string): Promise<CronTask> {
    return {
      id: crypto.randomUUID(),
      cron,
      prompt,
      createdAt: Date.now(),
      recurring: true,
      enabled: false,
      label: "Web 端暂不执行",
    };
  }

  async cronPause(): Promise<null> {
    return null;
  }

  async cronResume(): Promise<null> {
    return null;
  }

  async cronDelete(): Promise<boolean> {
    return true;
  }

  async cronDeleteAll(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async cronList(): Promise<CronTask[]> {
    return [];
  }

  // ── Files / window / voice ─────────────────────────────────────────────

  async openFileDialog(): Promise<null> {
    // No native picker on the web — project import is desktop-only for now.
    return null;
  }

  async readFile(): Promise<string> {
    throw new Error("Web 端不支持直接读取本地文件");
  }

  async writeFile(): Promise<boolean> {
    throw new Error("Web 端不支持直接写入本地文件");
  }

  async hideWindow(): Promise<void> {}

  async showWindow(): Promise<void> {}

  async isWindowVisible(): Promise<boolean> {
    return true;
  }

  async wakeStop(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async wakeConversation(on: boolean): Promise<{ ok: boolean; conversation: boolean }> {
    return { ok: true, conversation: on };
  }

  async ttsSpeak(): Promise<{ ok: boolean }> {
    return { ok: false };
  }

  async ttsStop(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  async ttsPlaybackEnded(): Promise<{ ok: boolean }> {
    return { ok: true };
  }

  onTtsStart(): Unsubscribe {
    return () => {};
  }

  onTtsPcm(): Unsubscribe {
    return () => {};
  }

  onTtsStreamEnd(): Unsubscribe {
    return () => {};
  }

  onTtsFlush(): Unsubscribe {
    return () => {};
  }

  onTtsEnd(): Unsubscribe {
    return () => {};
  }

  onWake(): Unsubscribe {
    return () => {};
  }

  onWakeCommand(): Unsubscribe {
    return () => {};
  }

  // ── SSE plumbing ───────────────────────────────────────────────────────

  private dispatch(sessionId: string, event: Record<string, unknown>): void {
    const stamped = { ...event, _sid: sessionId };
    for (const listener of this.listeners) {
      try {
        listener(stamped);
      } catch {
        /* one bad subscriber must not starve the rest */
      }
    }
  }

  private dispatchStreamEvent(sessionId: string, event: Record<string, unknown>): void {
    const shouldFrameCommentary = sessionId.startsWith("runtime:codex:")
      && event.type === "text_chunk"
      && event.messagePhase === "commentary"
      && typeof event.text === "string";
    if (!shouldFrameCommentary) {
      this.flushBufferedStreamText(sessionId);
      this.dispatch(sessionId, event);
      return;
    }

    const buffered = this.bufferedStreamText.get(sessionId);
    const sameItem = buffered
      && buffered.event._nativeRunId === event._nativeRunId
      && buffered.event.turnId === event.turnId
      && buffered.event.itemId === event.itemId;
    if (sameItem) {
      buffered.event = {
        ...buffered.event,
        ...event,
        text: String(buffered.event.text ?? "") + event.text,
      };
      return;
    }
    this.flushBufferedStreamText(sessionId);
    const timer = setTimeout(() => this.flushBufferedStreamText(sessionId), CODEX_COMMENTARY_FRAME_MS);
    this.bufferedStreamText.set(sessionId, { event: { ...event }, timer });
  }

  private flushBufferedStreamText(sessionId: string): void {
    const buffered = this.bufferedStreamText.get(sessionId);
    if (!buffered) return;
    this.bufferedStreamText.delete(sessionId);
    clearTimeout(buffered.timer);
    this.dispatch(sessionId, buffered.event);
  }

  private settle(sessionId: string): void {
    const resolve = this.pendingRuns.get(sessionId);
    if (resolve) {
      this.pendingRuns.delete(sessionId);
      resolve();
    }
  }

  private openStream(
    sessionId: string,
    cursor?: NativeStreamCursor,
    options: { waitForOpen?: boolean } = {},
  ): Promise<void> {
    if (this.streams.has(sessionId)) return Promise.resolve();
    this.thinkFilters.set(sessionId, new StreamingThinkFilter());
    const query = new URLSearchParams({ sessionId });
    if (Number.isSafeInteger(cursor?.sequence)) {
      query.set(sessionId.startsWith("runtime:") ? "afterSequence" : "afterEventId", String(cursor!.sequence));
    }
    if (sessionId.startsWith("runtime:") && cursor?.runId) query.set("afterRunId", cursor.runId);
    const source = new EventSource(`/api/agent/stream?${query.toString()}`);
    let sawTerminal = false;
    this.streams.set(sessionId, source);

    const waitForOpen = options.waitForOpen !== false;
    let gatePending = waitForOpen;
    let gateTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveGate: (() => void) | null = null;
    let rejectGate: ((error: Error) => void) | null = null;
    const opening = waitForOpen
      ? new Promise<void>((resolve, reject) => {
          resolveGate = resolve;
          rejectGate = reject;
          gateTimer = setTimeout(() => {
            gatePending = false;
            reject(new Error("事件流连接超时"));
          }, 8000);
        })
      : Promise.resolve();

    source.onopen = () => {
      if (!gatePending) return;
      gatePending = false;
      if (gateTimer) clearTimeout(gateTimer);
      resolveGate?.();
    };

    source.onmessage = (message) => {
      if (!message.data) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(message.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (typeof event._nativeSequence === "number") {
        const runId = typeof event._nativeRunId === "string" ? event._nativeRunId : undefined;
        if (!this.acceptNativeStreamEvent(sessionId, event._nativeSequence, runId)) return;
      }
      // Deduplicate transport delivery before mutating the stateful filter.
      // Otherwise a replayed partial tag can corrupt the next visible chunk.
      if (event.type === "text_chunk" && typeof event.text === "string") {
        event.text = this.thinkFilters.get(sessionId)!.push(event.text);
      }
      if (event.type === "done" || event.type === "error" || event.type === "turn_aborted") {
        // Flush the filter's held-back tail into the terminal event before
        // dispatching, so no visible text is lost to the partial-tag buffer.
        const tail = this.thinkFilters.get(sessionId)?.flush() ?? "";
        if (tail && event.type === "done" && typeof event.finalText === "string") {
          event.finalText = event.finalText + tail;
        }
        sawTerminal = true;
      }
      if (event.type === "text_chunk" && event.text === "") return; // fully filtered chunk
      this.dispatchStreamEvent(sessionId, event);
      if (event.type === "done" || event.type === "error" || event.type === "turn_aborted") {
        this.closeStream(sessionId);
        this.settle(sessionId);
      }
    };
    source.onerror = () => {
      if (gatePending && source.readyState === EventSource.CLOSED) {
        gatePending = false;
        if (gateTimer) clearTimeout(gateTimer);
        rejectGate?.(new Error("事件流连接失败"));
        return;
      }
      if (source.readyState !== EventSource.CLOSED) return; // auto-reconnecting
      // The connection died before the run settled (network drop): recover
      // the persisted reply from the session and re-stream it as text, so a
      // finished answer is never silently lost.
      this.closeStream(sessionId);
      if (sawTerminal) {
        this.settle(sessionId);
        return;
      }
      void (async () => {
        let visible = "";
        // Persistence is asynchronous and may complete shortly after the SSE
        // socket closes. Poll briefly instead of declaring failure too early.
        for (let attempt = 0; attempt < 8 && !visible; attempt++) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 750));
          try {
            const session = (await this.getSession(sessionId, { limit: 50 })) as {
              messages?: Array<{ role: string; content?: string }>;
            } | null;
            const messages = session?.messages ?? [];
            const lastUser = messages.map((m) => m.role).lastIndexOf("user");
            const recovery = messages
              .slice(lastUser + 1)
              .filter((m) => m.role === "assistant" && (m.content ?? "").trim())
              .map((m) => (m.content as string).trim())
              .join("\n\n");
            visible = stripThinkBlocks(recovery).trim();
          } catch {
            // retry while the session projection settles
          }
        }
        if (visible) {
          this.dispatch(sessionId, { type: "text_chunk", text: visible });
        } else {
          this.dispatch(sessionId, { type: "error", message: "连接中断，回复未能恢复，请重试" });
        }
        this.dispatch(sessionId, { type: "done", finalText: "" });
        this.settle(sessionId);
      })();
    };
    return opening;
  }

  private rememberNativeStreamCursor(sessionId: string, sequence: number, runId?: string): void {
    const previous = this.nativeStreamCursors.get(sessionId);
    const sameRun = previous && (
      previous.runId === runId
      || !runId
    );
    if (sameRun && sequence < previous.sequence) return;
    const resolvedRunId = runId ?? previous?.runId;
    this.nativeStreamCursors.set(sessionId, {
      sequence,
      ...(resolvedRunId ? { runId: resolvedRunId } : {}),
    });
  }

  private acceptNativeStreamEvent(sessionId: string, sequence: number, runId?: string): boolean {
    const previous = this.nativeStreamCursors.get(sessionId);
    const sameRun = previous && (
      previous.runId === runId
      || !runId
    );
    if (sameRun && sequence <= previous.sequence) return false;
    this.rememberNativeStreamCursor(sessionId, sequence, runId);
    return true;
  }

  private closeStream(sessionId: string): void {
    this.flushBufferedStreamText(sessionId);
    const source = this.streams.get(sessionId);
    if (source) {
      source.close();
      this.streams.delete(sessionId);
      this.thinkFilters.delete(sessionId);
    }
  }
}

/** The gateway implements every port member except browser-handled voice. */
export type WebAgentGateway = Omit<AgentApi, BrowserHandled>;
