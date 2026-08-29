import type {
  AgentApi,
  AgentDefinition,
  CronTask,
  LSPServerConfig,
  MCPServer,
} from "../../domain/ports/agent-port";
import { WEB_DEFAULT_PROJECT_ID } from "../../domain/ports/agent-port";
import { HttpClient, listOf } from "./http-client";
import { LocalCollection } from "../local/local-collection";
import type { LocalSettingsRepository } from "../local/local-settings-repository";
import { StreamingThinkFilter, stripThinkBlocks } from "./think-filter";

type EventListener = (event: unknown) => void;
type Unsubscribe = () => void;

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
 *   - the SSE stream is opened BEFORE the run starts so no early text_chunk
 *     is lost (the stream route subscribes without requiring the session).
 *
 * Voice wake/dictation are deliberately NOT implemented: the renderer's
 * lib/speech falls back to the Web Speech API when those bridge methods are
 * absent. TTS is reported unavailable ({ok:false}).
 */
export class AgentHttpGateway {
  private readonly streams = new Map<string, EventSource>();
  private readonly pendingRuns = new Map<string, () => void>();
  private readonly listeners = new Set<EventListener>();
  private readonly thinkFilters = new Map<string, StreamingThinkFilter>();

  private readonly agentDefs = new LocalCollection<AgentDefinition>("webapp.agentDefs");
  private readonly lspServers = new LocalCollection<LSPServerConfig>("webapp.lspServers");
  private readonly uploads = new Map<string, Record<string, unknown>>();

  constructor(
    private readonly http: HttpClient,
    private readonly settings: LocalSettingsRepository,
  ) {}

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
  ): Promise<unknown[]> {
    await this.openStream(sessionId);
    const finished = new Promise<void>((resolve) => {
      this.pendingRuns.set(sessionId, resolve);
    });
    try {
      // A user-configured model profile travels with the run; without one the
      // server keeps using its own env configuration.
      const model = this.settings.getModelOverride();
      await this.http.post("/api/agent/run", {
        input,
        sessionId,
        ...(images?.length ? { images } : {}),
        ...(model ? { model } : {}),
      });
    } catch (err) {
      this.dispatch(sessionId, {
        type: "error",
        message: err instanceof Error ? err.message : "无法启动运行",
      });
      this.closeStream(sessionId);
      this.settle(sessionId);
    }
    await finished;
    return [];
  }

  async steer(input: string, sessionId: string, _agentName?: string): Promise<boolean> {
    const res = await this.http.post<{ steered: boolean }>("/api/agent/steer", { input, sessionId });
    if (!res.steered) {
      // No active run for this session — mirror desktop: start a new run.
      void this.run(input, sessionId).catch(() => {});
    }
    return true;
  }

  async abort(): Promise<void> {
    try {
      await this.http.post("/api/agent/abort");
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

  async listChildSessions(_parentId: string): Promise<unknown[]> {
    // The server host builds no sub-agents — no child sessions exist.
    return [];
  }

  async getSession(id: string): Promise<unknown> {
    try {
      const session = await this.http.get<Record<string, unknown>>(`/api/sessions/${encodeURIComponent(id)}`);
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
      return session;
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async createSession(title: string, projectId?: string): Promise<unknown> {
    return this.http.post("/api/sessions", {
      title,
      projectId: projectId || WEB_DEFAULT_PROJECT_ID,
    });
  }

  async deleteSession(id: string): Promise<void> {
    await this.http.delete(`/api/sessions/${encodeURIComponent(id)}`);
  }

  // ── Projects (server has no project CRUD yet — one synthetic project) ──

  async listProjects(): Promise<unknown[]> {
    return [{ id: WEB_DEFAULT_PROJECT_ID, name: "会话", description: "", created: "", updated: "" }];
  }

  async getProject(id: string): Promise<unknown> {
    return (await this.listProjects()).find((project) => (project as { id: string }).id === id) ?? null;
  }

  async createProject(name: string): Promise<unknown> {
    return { id: WEB_DEFAULT_PROJECT_ID, name, description: "", created: "", updated: "" };
  }

  async updateProject(): Promise<unknown> {
    return null;
  }

  async deleteProject(): Promise<void> {
    // The synthetic project cannot be deleted.
  }

  async checkProjectPath(): Promise<boolean> {
    return true;
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

  private settle(sessionId: string): void {
    const resolve = this.pendingRuns.get(sessionId);
    if (resolve) {
      this.pendingRuns.delete(sessionId);
      resolve();
    }
  }

  private async openStream(sessionId: string): Promise<void> {
    if (this.streams.has(sessionId)) return;
    this.thinkFilters.set(sessionId, new StreamingThinkFilter());
    const source = new EventSource(`/api/agent/stream?sessionId=${encodeURIComponent(sessionId)}`);
    let sawTerminal = false;
    this.streams.set(sessionId, source);

    // Do not start the agent until the SSE transport is actually open. Fast
    // replies can otherwise finish before the subscription is registered.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("事件流连接超时")), 8000);
      source.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      const initialError = source.onerror;
      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) {
          clearTimeout(timer);
          reject(new Error("事件流连接失败"));
        }
        if (typeof initialError === "function") initialError.call(source, new Event("error"));
      };
    });

    source.onmessage = (message) => {
      if (!message.data) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(message.data) as Record<string, unknown>;
      } catch {
        return;
      }
      // Never render reasoning tags: filter streamed text through the
      // chunk-boundary-safe think filter.
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
      this.dispatch(sessionId, event);
      if (event.type === "done" || event.type === "error" || event.type === "turn_aborted") {
        this.closeStream(sessionId);
        this.settle(sessionId);
      }
    };
    source.onerror = () => {
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
            const session = (await this.getSession(sessionId)) as {
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
  }

  private closeStream(sessionId: string): void {
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
