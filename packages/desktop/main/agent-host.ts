import {
  AgentBuilder,
  ContextCompactor,
  SQLiteSettingsStore,
  SQLiteSessionStore,
  SQLiteMemoryStore,
  SQLiteMCPServerStore,
  SQLiteSkillStore,
  SQLitePluginStore,
  SQLiteUploadStore,
  SQLiteProjectStore,
  SQLiteAgentStore,
  SQLiteLSPServerStore,
  SkillLoader,
  TodoAddTool,
  TodoUpdateTool,
  TodoListTool,
  DispatchAgentTool,
  WaitAgentTool,
  AskUserTool,
  type AskUserRequest,
  CronCreateTool,
  CronDeleteTool,
  CronListTool,
  LspDiagnosticsTool,
  LspHoverTool,
  LspDefinitionTool,
  LspReferencesTool,
  CronTasks,
  CronTaskLock,
  MCPManager,
  LSPManager,
  type IAgentLoop,
  type AgentEvent,
  type CronTask,
  type Session,
  type SettingsData,
  type ModelProfile,
  type Message,
  type TodoItem,
} from "@agent/core";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { CronScheduler } from "./cron/cronScheduler.js";
import { MCPConnectionManager } from "./mcp-connection-manager.js";
import { SubAgentDispatcher } from "./sub-agent-dispatcher.js";
import { QuestionManager } from "./question-manager.js";

export function shouldInterruptPreviousRun(runCountIncludingCurrent: number): boolean {
  return runCountIncludingCurrent > 1;
}

export class AgentHost {
  private agent: IAgentLoop | null = null;
  private builder: AgentBuilder;
  private readonly settingsStore: SQLiteSettingsStore;
  private readonly sessionStore: SQLiteSessionStore;
  private readonly memoryStore: SQLiteMemoryStore;
  private readonly mcpStore: SQLiteMCPServerStore;
  private readonly skillStore: SQLiteSkillStore;
  private readonly pluginStore: SQLitePluginStore;
  private readonly uploadStore: SQLiteUploadStore;
  private readonly projectStore: SQLiteProjectStore;
  private readonly agentStore: SQLiteAgentStore;
  private readonly lspStore: SQLiteLSPServerStore;
  private readonly lspManager: LSPManager;
  private readonly subscribers = new Set<(event: AgentEvent & { _sid: string }) => void>();
  /** Current todo list for the active run (cleared at each top-level run) */
  private currentTodos: TodoItem[] = [];
  /** Session ID of the currently active top-level run (used to tag todo_update events) */
  private currentSessionId: string = "";
  /** Working directory tracked for sub-agent dispatch */
  private workingDirectory: string;
  /** Run-level ID used for the todos folder name (sessionId_runId) */
  private currentRunId: string = "";
  /** Cron task store (disk-backed) */
  private readonly cronTasks: CronTasks;
  /** Per-task session lock (file-backed) */
  private readonly cronLock: CronTaskLock;
  /** Cron scheduler */
  private readonly cronScheduler: CronScheduler;
  /** Count of concurrent runs (supports interruption nesting) */
  private _runCount = 0;
  /** MCP connection manager — handles server lifecycle */
  private readonly mcpConnectionManager: MCPConnectionManager;
  /** Queue of pending prompts enqueued by the cron scheduler */
  private pendingQueue: Array<{ prompt: string; sessionId: string }> = [];
  private queueDraining = false;
  /** Background sub-agents launched by dispatch_agent (non-blocking) */
  private readonly subAgentDispatcher: SubAgentDispatcher;
  /** Manages ask_user question lifecycle */
  private readonly questionManager: QuestionManager;

  constructor(baseDir: string) {
    this.workingDirectory = baseDir;
    this.settingsStore = new SQLiteSettingsStore(baseDir);
    this.sessionStore = new SQLiteSessionStore(baseDir);
    this.memoryStore = new SQLiteMemoryStore(baseDir);
    this.mcpStore = new SQLiteMCPServerStore(baseDir);
    this.skillStore = new SQLiteSkillStore(baseDir);
    this.pluginStore = new SQLitePluginStore(baseDir);
    this.uploadStore = new SQLiteUploadStore(baseDir);
    this.projectStore = new SQLiteProjectStore(baseDir);
    this.agentStore = new SQLiteAgentStore(baseDir);
    this.lspStore = new SQLiteLSPServerStore(baseDir);
    this.lspManager = new LSPManager();
    this.mcpConnectionManager = new MCPConnectionManager(this.mcpStore);
    this.subAgentDispatcher = new SubAgentDispatcher(
      this.agentStore,
      this.sessionStore,
      this.settingsStore,
      this.memoryStore,
      (builder, sid, allowDispatch) => this.registerSessionTools(builder, sid, allowDispatch),
      (event, sid) => this.emit(event, sid),
    );
    this.questionManager = new QuestionManager((event, sid) => this.emit(event, sid));
    this.builder = new AgentBuilder()
      .withWorkingDirectory(baseDir)
      .withMemoryStore(this.memoryStore)
      .withSessionStore(this.sessionStore);
    this.cronTasks = new CronTasks(baseDir);
    this.cronLock = new CronTaskLock(baseDir);
    this.cronScheduler = new CronScheduler(
      this.cronTasks,
      (task) => this.onCronFire(task),
      (tasks) => this.onCronTasksChanged(tasks),
    );
    this.cronScheduler.start();
    this.tryConfigureFromStore();
  }

  /** Try to build the model provider from stored settings */
  private tryConfigureFromStore(): void {
    const settings = this.settingsStore.getAll();
    // Restore working directory from persisted settings (overrides process.cwd())
    if (settings.workingDirectory) {
      this.workingDirectory = settings.workingDirectory;
      this.builder.withWorkingDirectory(settings.workingDirectory);
    }
    if (settings.isConfigured) {
      try {
        this.builder.withModel(settings.modelProvider, {
          apiKey: settings.apiKey,
          baseUrl: settings.baseUrl || undefined,
          modelId: settings.modelId,
        });
        this.builder.withMaxIterations(settings.maxIterations);
        this.builder.withMaxTokens((settings.contextWindow ?? 100) * 1000);
      } catch (err) {
        console.error("Failed to configure model from stored settings:", err);
      }
    }
  }

  /**
   * Hot-switch the active model profile without touching other settings.
   * Takes effect on the next agent run.
   */
  setActiveProfile(profileId: string): void {
    const current = this.settingsStore.getAll();
    const profile = current.profiles.find((p) => p.id === profileId);
    if (!profile) return;

    // Persist the switch — run() will pick up the new active profile on next call
    const updated: SettingsData = {
      ...current,
      activeProfileId: profileId,
      modelProvider: profile.provider,
      modelId: profile.modelId,
      apiKey: profile.apiKey,
      baseUrl: profile.baseUrl,
      isConfigured: Boolean(profile.apiKey),
    };
    this.settingsStore.saveAll(updated);
  }

  /** Save settings and reconfigure the builder */
  configure(settings: SettingsData): void {
    this.settingsStore.saveAll(settings);
    this.workingDirectory = settings.workingDirectory || this.workingDirectory;
    this.builder = new AgentBuilder()
      .withWorkingDirectory(settings.workingDirectory)
      .withMemoryStore(this.memoryStore)
      .withSessionStore(this.sessionStore);
    if (settings.isConfigured) {
      this.builder.withModel(settings.modelProvider, {
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl || undefined,
        modelId: settings.modelId,
      });
    }
    this.builder.withMaxIterations(settings.maxIterations);
    this.builder.withMaxTokens((settings.contextWindow ?? 100) * 1000);
  }

  getSettings(): SettingsData & { activeAgentIds?: string[] } {
    const base = this.settingsStore.getAll();
    const raw = this.settingsStore.get("activeAgentIds");
    const activeAgentIds: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    return { ...base, activeAgentIds };
  }

  /** Toggle an agent in/out of the active agents list */
  toggleActiveAgent(agentId: string): string[] {
    const raw = this.settingsStore.get("activeAgentIds");
    const current: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const updated =
      current.includes(agentId)
        ? current.filter((id) => id !== agentId)
        : [...current, agentId];
    this.settingsStore.set("activeAgentIds", JSON.stringify(updated));
    return updated;
  }

  /** Replace the entire active agents list */
  setActiveAgentIds(ids: string[]): void {
    this.settingsStore.set("activeAgentIds", JSON.stringify(ids));
  }

  getBuilder(): AgentBuilder {
    return this.builder;
  }

  getSessionStore(): SQLiteSessionStore {
    return this.sessionStore;
  }

  getMemoryStore(): SQLiteMemoryStore {
    return this.memoryStore;
  }

  getMCPStore(): SQLiteMCPServerStore {
    return this.mcpStore;
  }

  getSkillStore(): SQLiteSkillStore {
    return this.skillStore;
  }

  getPluginStore(): SQLitePluginStore {
    return this.pluginStore;
  }

  getUploadStore(): SQLiteUploadStore {
    return this.uploadStore;
  }

  getAgentStore(): SQLiteAgentStore {
    return this.agentStore;
  }

  getProjectStore(): SQLiteProjectStore {
    return this.projectStore;
  }

  getLSPStore(): SQLiteLSPServerStore {
    return this.lspStore;
  }

  /** Update the agent builder's working directory (takes effect on next run) */
  setWorkingDirectory(path: string): void {
    this.workingDirectory = path;
    this.builder.withWorkingDirectory(path);
    // Also persist so settings panel reflects current working dir
    const current = this.settingsStore.getAll();
    this.settingsStore.saveAll({ ...current, workingDirectory: path });
  }

  // ── Todo management ──────────────────────────────────────────────────────

  private setTodos(todos: TodoItem[]): void {
    this.currentTodos = todos;
    this.emit({ type: "todo_update", todos: [...todos] }, this.currentSessionId);
    // Persist to project working directory (fire-and-forget)
    if (this.currentRunId) {
      void this.persistTodos(todos);
    }
  }

  private async persistTodos(todos: TodoItem[]): Promise<void> {
    try {
      const dir = join(this.workingDirectory, ".agent-todos", this.currentRunId);
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, "todos.json"),
        JSON.stringify({ runId: this.currentRunId, updatedAt: new Date().toISOString(), todos }, null, 2),
        "utf-8",
      );
    } catch {
      // Non-critical — ignore write errors silently
    }
  }

  getTodos(): TodoItem[] {
    return this.currentTodos;
  }

  // ── MCP probe ────────────────────────────────────────────────────────────

  /**
   * Temporarily connect to an MCP server, list its tools, then disconnect.
   * Delegates to MCPConnectionManager.
   */
  async probeServerTools(config: Parameters<typeof MCPManager.prototype.connectServer>[0]): Promise<Array<{ name: string; description: string }>> {
    return this.mcpConnectionManager.probeServerTools(config);
  }

  // ── MCP server connection ────────────────────────────────────────────────

  /**
   * Connect all enabled MCP servers and register their tools into the builder's registry.
   * Delegates to MCPConnectionManager.
   */
  private async connectMCPServers(builder: AgentBuilder): Promise<void> {
    await this.mcpConnectionManager.connectServers(builder.getToolRegistry());
  }

  // ── Session-level tool registration ──────────────────────────────────────

  /**
   * Register session-aware tools (todo + dispatch) on the given registry.
   * Must be called AFTER buildSync() so enabledTools filter doesn't remove them.
   *
   * Main agent: uses persistent shared this.currentTodos so todos survive across turns.
   * Sub-agents: use isolated per-dispatch todo state so they don't pollute the parent session.
   */
  private registerSessionTools(
    builder: AgentBuilder,
    sessionId: string,
    allowDispatch = true,
  ): void {
    const registry = builder.getToolRegistry();

    // Main agent keeps shared state that survives multiple turns in the same session.
    // Sub-agents get an isolated todo list scoped to their dispatch and emit events
    // tagged with their own sessionId so the renderer routes them correctly.
    const isMainAgent = builder === this.builder;
    let getTodos: () => TodoItem[];
    let setTodosCallback: (todos: TodoItem[]) => void;
    if (isMainAgent) {
      getTodos = () => this.currentTodos;
      setTodosCallback = (todos) => this.setTodos(todos);
    } else {
      let subTodos: TodoItem[] = [];
      getTodos = () => subTodos;
      setTodosCallback = (todos) => {
        subTodos = todos;
        this.emit({ type: "todo_update", todos: [...todos] }, sessionId);
      };
    }

    registry.register(new TodoAddTool(getTodos, setTodosCallback));
    registry.register(new TodoUpdateTool(getTodos, setTodosCallback));
    registry.register(new TodoListTool(getTodos));
    if (allowDispatch) {
      registry.register(
        new DispatchAgentTool((name, task, sid) =>
          this.subAgentDispatcher.dispatch(name, task, sid),
        ),
      );
      registry.register(
        new WaitAgentTool((subSessionId, timeoutMs) =>
          this.subAgentDispatcher.wait(subSessionId, timeoutMs),
        ),
      );
    }
    registry.register(new CronCreateTool((cron, prompt, options) => this.createCronTask(cron, prompt, options)));
    registry.register(new CronDeleteTool(this.cronTasks));
    registry.register(new CronListTool(this.cronTasks));

    // ask_user tool — delegates to QuestionManager
    registry.register(new AskUserTool(async (request: AskUserRequest) => {
      return this.questionManager.create(request, sessionId);
    }));

    // LSP tools
    const getConfigs = () => this.lspStore.list();
    registry.register(new LspDiagnosticsTool(this.lspManager, getConfigs));
    registry.register(new LspHoverTool(this.lspManager, getConfigs));
    registry.register(new LspDefinitionTool(this.lspManager, getConfigs));
    registry.register(new LspReferencesTool(this.lspManager, getConfigs));
  }

  /**
   * List all skills by scanning the filesystem (all priority dirs) and merging
   * with SQLite. Filesystem discovery wins over SQLite-only records.
   * This is what the UI "/" autocomplete and SkillManager use.
   */
  async listSkills(): Promise<Array<{ name: string; description: string; filePath: string; source: string; enabled?: boolean }>> {
    const loader = new SkillLoader();
    const fsMetas = await loader.loadAll(this.workingDirectory);
    const dbSkills = await this.skillStore.listAll();
    const dbMap = new Map(dbSkills.map((s) => [s.name, s]));

    // Build merged list: filesystem-discovered skills first
    const seen = new Set<string>();
    const result: Array<{ name: string; description: string; filePath: string; source: string; enabled?: boolean }> = [];
    for (const meta of fsMetas) {
      seen.add(meta.name);
      const db = dbMap.get(meta.name);
      result.push({ name: meta.name, description: meta.description, filePath: meta.filePath, source: meta.source, enabled: db ? (db as any).enabled !== false : true });
    }
    // Append SQLite-only entries (imported via UI but no longer on disk in scanned dirs)
    for (const db of dbSkills) {
      if (!seen.has(db.name)) {
        result.push({ name: db.name, description: db.description, filePath: (db as any).filePath ?? "", source: (db as any).source ?? "custom", enabled: (db as any).enabled !== false });
      }
    }
    return result;
  }

  /**
   * Import a skill from a local path (directory or SKILL.md file).
   * Installs to ~/.agent/skills/<name>/ (global scope) and registers
   * immediately in the current builder so it is active this session.
   */
  async importSkill(sourcePath: string): Promise<{ name: string; description: string }> {
    const globalSkillsDir = join(homedir(), ".agent", "skills");
    const loader = new SkillLoader();
    const meta = await loader.installSkill(sourcePath, globalSkillsDir);

    // Load full content to save into the SQLite skill store (shows in UI)
    const full = await loader.loadFromFile(meta.filePath);
    await this.skillStore.save(full);

    // Register in the live builder skillRegistry so the current session picks it up
    this.builder.getSkillRegistry().register(meta);

    return { name: meta.name, description: meta.description };
  }

  async createSession(title: string, projectId?: string): Promise<Session> {
    return this.sessionStore.create({
      id: crypto.randomUUID(),
      projectId: projectId || "",
      title,
      status: "idle",
      messages: [],
      events: [],
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      metadata: {},
    });
  }

  subscribe(fn: (event: AgentEvent & { _sid: string }) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  private emit(event: AgentEvent, sid = ""): void {
    const envelope = { ...event, _sid: sid };
    for (const fn of this.subscribers) {
      try { fn(envelope); } catch { /* ignore */ }
    }
  }

  async *run(
    input: string,
    sessionId: string,
    agentIds?: string[],
    agentName?: string,
    images?: string[],
  ): AsyncIterable<AgentEvent> {
    if (this.isCompactCommand(input)) {
      yield { type: "thinking", message: "Compacting session context…" };
      this.emit({ type: "thinking", message: "Compacting session context…" }, sessionId);
      try {
        const result = await this.compactSession(sessionId);
        const compactedEvent: AgentEvent = {
          type: "compacted",
          summary: result.summary,
          removedMessages: result.removedMessages,
        };
        this.emit(compactedEvent, sessionId);
        yield compactedEvent;
        const doneEvent: AgentEvent = {
          type: "done",
          finalText: `Context compacted. Removed ${result.removedMessages} older messages; current environment will be re-injected on the next run.`,
        };
        this.emit(doneEvent, sessionId);
        yield doneEvent;
      } catch (err) {
        const errorEvent: AgentEvent = {
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        };
        this.emit(errorEvent, sessionId);
        yield errorEvent;
      }
      return;
    }

    // ── 0. If a run is already active, interrupt it and inject turn_aborted marker ──
    if (shouldInterruptPreviousRun(this._runCount)) {
      yield { type: "thinking", message: "Interrupting previous turn..." };
      this.abort();
      this.subAgentDispatcher.abortAll();
      // Small yield so the aborted generator can wind down
      await new Promise((r) => setTimeout(r, 100));
      // Inject <turn_aborted> marker into session history so the model sees it
      await this.sessionStore.addMessage(sessionId, {
        role: "user",
        content: "<turn_aborted>\nThe user interrupted the previous turn on purpose. Any running tools/commands may have been aborted and partially executed.\n</turn_aborted>",
        name: "__interrupt__",
      } as Message).catch(() => {});
    }

    // ── 1. Track session and clear todos only when switching to a new session ───
    // Clearing todos every run caused "No matching todo found" when the LLM tried
    // to update todos added in a previous turn of the SAME session.
    const isNewSession = this.currentSessionId !== sessionId;
    this.currentSessionId = sessionId;
    this.currentRunId = `${sessionId}_${Date.now()}`;
    if (isNewSession) {
      // Fresh session: reset todos without emitting an event (renderer manages its own state)
      this.currentTodos = [];
    }

    // ── 2. Re-read latest model settings ─────────────────────────────────
    const latestSettings = this.settingsStore.getAll();
    if (latestSettings.isConfigured) {
      this.builder.withModel(latestSettings.modelProvider, {
        apiKey: latestSettings.apiKey,
        baseUrl: latestSettings.baseUrl || undefined,
        modelId: latestSettings.modelId,
      });
      this.builder.withMaxIterations(latestSettings.maxIterations);
      this.builder.withMaxTokens((latestSettings.contextWindow ?? 100) * 1000);
    }

    // ── 3. Determine agents to run ────────────────────────────────────────
    // agentIds from caller OR fall back to active agent from settings
    const resolvedIds: Array<string | null> =
      agentIds && agentIds.length > 0 ? agentIds : [null];
    const isMultiAgent = resolvedIds.length > 1;

    // ── 4. Pre-create todo items for multi-agent runs ─────────────────────
    if (isMultiAgent) {
      const allAgents = await this.agentStore.list();
      const initialTodos: TodoItem[] = resolvedIds
        .filter((id): id is string => id !== null)
        .map((id) => {
          const def = allAgents.find((a) => a.id === id);
          return {
            id: crypto.randomUUID(),
            title: def ? `${def.name} 处理任务` : `智能体 (${id.slice(0, 6)}) 处理任务`,
            agentName: def?.name,
            status: "pending" as const,
          };
        });
      this.setTodos(initialTodos);
    }

    // ── 5. Ensure session exists + save user message (once) ───────────────
    const existing = await this.sessionStore.get(sessionId);
    if (!existing) {
      await this.sessionStore.create({
        id: sessionId,
        projectId: "",
        title: input.slice(0, 60) || "New Session",
        status: "active",
        messages: [],
        events: [],
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        metadata: {},
      });
    } else {
      // Always update title to the latest user message
      await this.sessionStore.update(sessionId, {
        status: "active" as const,
        title: input.slice(0, 60) || existing.title,
      });
    }
    await this.sessionStore.addMessage(sessionId, {
      role: "user",
      content: input,
      // Reuse name field to persist the @agent label for session restore
      name: agentName || undefined,
    } as Message);

    // ── 6. Run each agent in sequence ─────────────────────────────────────
    for (let idx = 0; idx < resolvedIds.length; idx++) {
      const agentId = resolvedIds[idx];

      // Reset per-run overrides before applying agent def
      this.builder.withSystemPrompt(undefined).withEnabledTools([]).withEnabledSkills([]);

      if (agentId !== null) {
        // Apply a specific agent def
        const agentDef = await this.agentStore.get(agentId);
        console.log("[agent-host] @agent run — id:", agentId, "def:", agentDef?.name, "systemPrompt:", agentDef?.systemPrompt?.slice(0, 80));
        if (agentDef) {
          if (agentDef.capabilities.profileId) {
            const profile = latestSettings.profiles.find(
              (p) => p.id === agentDef.capabilities.profileId,
            );
            if (profile) {
              this.builder.withModel(profile.provider, {
                apiKey: profile.apiKey,
                baseUrl: profile.baseUrl || undefined,
                modelId: profile.modelId,
              });
            }
          }
          if (agentDef.systemPrompt || agentDef.name) {
            let resolvedPrompt = agentDef.systemPrompt || "";
            for (const ph of agentDef.contextPlaceholders) {
              resolvedPrompt = resolvedPrompt.replaceAll(
                `{{${ph.key}}}`,
                ph.defaultValue,
              );
            }
            // Prepend agent identity header so the model always knows who it is
            const identityHeader = `# 角色：${agentDef.name}${
              agentDef.description ? `\n${agentDef.description}` : ""
            }\n你的名字是「${agentDef.name}」。不要提及任何底层模型或开发公司的信息，始终以此角色回复。`;
            const finalPrompt = resolvedPrompt ? `${identityHeader}\n\n${resolvedPrompt}` : identityHeader;
            console.log("[agent-host] setting systemPrompt:", finalPrompt.slice(0, 120));
            this.builder.withSystemPrompt(finalPrompt);
          }
          this.builder.withEnabledTools(agentDef.capabilities.enabledTools);
          this.builder.withEnabledSkills(agentDef.capabilities.enabledSkills);
          if (agentDef.maxIterations > 0) {
            this.builder.withMaxIterations(agentDef.maxIterations);
          }
          // Mark this agent's todo as in-progress
          if (isMultiAgent) {
            this.setTodos(
              this.currentTodos.map((t) =>
                t.agentName === agentDef.name
                  ? { ...t, status: "in-progress" }
                  : t,
              ),
            );
          }
        }
      } else {
        // Use first active agent from settings
        const rawActiveIds = this.settingsStore.get("activeAgentIds");
        const activeIds: string[] = rawActiveIds ? (JSON.parse(rawActiveIds) as string[]) : [];
        const activeAgentId = activeIds[0] ?? "";
        if (activeAgentId) {
          const agentDef = await this.agentStore.get(activeAgentId);
          if (agentDef) {
            if (agentDef.capabilities.profileId) {
              const profile = latestSettings.profiles.find(
                (p) => p.id === agentDef.capabilities.profileId,
              );
              if (profile) {
                this.builder.withModel(profile.provider, {
                  apiKey: profile.apiKey,
                  baseUrl: profile.baseUrl || undefined,
                  modelId: profile.modelId,
                });
              }
            }
            if (agentDef.systemPrompt || agentDef.name) {
              let resolvedPrompt = agentDef.systemPrompt || "";
              for (const ph of agentDef.contextPlaceholders) {
                resolvedPrompt = resolvedPrompt.replaceAll(
                  `{{${ph.key}}}`,
                  ph.defaultValue,
                );
              }
              // Fallback active agent: apply role context but allow model to reveal its identity
              const identityHeader = `# 当前角色：${agentDef.name}${
                agentDef.description ? `\n${agentDef.description}` : ""
              }`;
              this.builder.withSystemPrompt(
                resolvedPrompt ? `${identityHeader}\n\n${resolvedPrompt}` : identityHeader,
              );
            }
            this.builder.withEnabledTools(agentDef.capabilities.enabledTools);
            this.builder.withEnabledSkills(agentDef.capabilities.enabledSkills);
            if (agentDef.maxIterations > 0) {
              this.builder.withMaxIterations(agentDef.maxIterations);
            }
          }
        }
      }

      // Build the agent loop
      this.agent = this.builder.buildSync();
      // Register session tools (todo, dispatch, cron, ask_user, lsp) after build
      this.registerSessionTools(this.builder, sessionId);
      // Connect enabled MCP servers and register their tools
      await this.connectMCPServers(this.builder);

      // For subsequent agents in a multi-agent run: they'll see session history
      // from previous agents when AgentLoop loads the session at run() start.
      // We pass the original input — subsequent agents see context in history.
      // Images only go to the FIRST agent (they belong to the first user message).
      const agentInput = input;
      const agentImages = idx === 0 ? images : undefined;

      let assistantText = "";
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }> = [];
      // Persistent lookup for tool call names (survives pendingToolCalls clearing)
      const toolCallNameMap = new Map<string, string>();

      for await (const event of this.agent.run(agentInput, sessionId, agentImages)) {
        this.emit(event, sessionId);
        yield event;

        await this.sessionStore.addEvent(sessionId, event);

        if (event.type === "text_chunk" && event.text) {
          assistantText += event.text;
        }

        if (event.type === "tool_call" && event.toolCall) {
          pendingToolCalls.push(event.toolCall);
          toolCallNameMap.set(event.toolCall.id, event.toolCall.name);
        }

        if (event.type === "tool_result" && event.result) {
          if (pendingToolCalls.length > 0) {
            await this.sessionStore.addMessage(sessionId, {
              role: "assistant",
              content: assistantText,
              toolCalls: [...pendingToolCalls],
            } as Message);
            assistantText = "";
            pendingToolCalls.length = 0;
          }
          await this.sessionStore.addMessage(sessionId, {
            role: "tool",
            content: event.result.content,
            toolCallId: event.result.toolCallId,
            name: toolCallNameMap.get(event.result.toolCallId),
          } as Message);
        }

        if (event.type === "done") {
          const finalText = (event.finalText ?? assistantText).trim();
          if (finalText) {
            await this.sessionStore.addMessage(sessionId, {
              role: "assistant",
              content: finalText,
            } as Message);
          }
        }
      }

      // Mark this agent's todo as completed
      if (isMultiAgent && agentId !== null) {
        const agentDef = await this.agentStore.get(agentId);
        if (agentDef) {
          this.setTodos(
            this.currentTodos.map((t) =>
              t.agentName === agentDef.name
                ? { ...t, status: "completed" }
                : t,
            ),
          );
        }
      }
    }

    await this.sessionStore.update(sessionId, { status: "completed" });
  }

  /**
   * Steer a new user input into an already-running session without interrupting.
   * If an ask_user prompt is pending, the input answers it immediately so the
   * loop can continue while blocked in tool execution.
   * If the agent loop is active, the message is saved with name "__steer__" so
   * AgentLoop picks it up on its next iteration via the session checkpoint.
   * If no agent is running, it saves normally and returns false (caller should
   * start a new run via the run() method).
   */
  async steerInput(input: string, sessionId: string, agentName?: string): Promise<boolean> {
    const answeredQuestion = this.questionManager.answerLatest(sessionId, input);
    await this.sessionStore.addMessage(sessionId, {
      role: "user",
      content: input,
      name: answeredQuestion ? undefined : "__steer__",
    } as Message);
    if (answeredQuestion) {
      this.emit({ type: "thinking", message: `User answered: ${input.slice(0, 60)}` }, sessionId);
      return true;
    }
    const isRunning = this._runCount > 0;
    if (!isRunning) {
      // Update session title even when not running
      const existing = await this.sessionStore.get(sessionId);
      if (existing) {
        await this.sessionStore.update(sessionId, { title: input.slice(0, 60) || existing.title });
      }
    }
    // Emit the steer event so the renderer updates the UI
    this.emit({ type: "thinking", message: `User added: ${input.slice(0, 60)}` }, sessionId);
    return isRunning;
  }

  /**
   * Resolve a pending ask_user question with the user's answer.
   * Called from the renderer via IPC when the user selects an option or types a response.
   */
  answerQuestion(questionId: string, answer: string, selectedIndices?: number[]): boolean {
    return this.questionManager.answer(questionId, answer, selectedIndices);
  }

  abort(): void {
    this.agent?.abort();
    this.questionManager.rejectAll("Agent aborted");
  }

  // ── Cron task public API ─────────────────────────────────────────────────

  createCronTask(
    cron: string,
    prompt: string,
    options?: Partial<Pick<CronTask, "recurring" | "label" | "sessionId">> & { agentId?: string },
  ): CronTask {
    const task = this.cronTasks.create({ cron, prompt, enabled: true, recurring: true, ...options });
    // Acquire session lock immediately if a sessionId was supplied
    if (task.sessionId) {
      this.cronLock.acquire(task.id, task.sessionId, options?.agentId);
    }
    this.emit({ type: "cron_update", tasks: this.cronTasks.load() });
    return task;
  }

  pauseCronTask(id: string): CronTask | null {
    const task = this.cronTasks.pause(id);
    this.emit({ type: "cron_update", tasks: this.cronTasks.load() });
    return task;
  }

  resumeCronTask(id: string): CronTask | null {
    const task = this.cronTasks.resume(id);
    this.emit({ type: "cron_update", tasks: this.cronTasks.load() });
    return task;
  }

  deleteCronTask(id: string): boolean {
    const result = this.cronTasks.delete(id);
    // Remove the lock as well
    this.cronLock.release(id);
    this.emit({ type: "cron_update", tasks: this.cronTasks.load() });
    return result;
  }

  deleteAllCronTasks(): void {
    // Release all locks
    for (const task of this.cronTasks.load()) {
      this.cronLock.release(task.id);
    }
    this.cronTasks.deleteAll();
    this.emit({ type: "cron_update", tasks: [] });
  }

  listCronTasks(): CronTask[] {
    return this.cronTasks.load();
  }

  // ── Running state + pending prompt queue ─────────────────────────────────

  /** Called when the agent loop starts/stops to gate queue draining (counter-based). */
  setRunning(v: boolean): void {
    const prev = this._runCount;
    this._runCount += v ? 1 : -1;
    if (this._runCount < 0) this._runCount = 0;
    if (prev > 0 && this._runCount === 0) void this.drainPendingQueue();
  }

  /** Called by CronScheduler when a task fires. */
  private onCronFire(task: CronTask): void {
    // Prefer the lock's sessionId (authoritative), fall back to task field
    const lock = this.cronLock.get(task.id);
    const sessionId = lock?.sessionId ?? task.sessionId ?? "";
    void this.enqueuePendingNotification(task.prompt, sessionId);
  }

  /**
   * Handle session deletion: release locks held by the session and
   * re-assign them to the most-recently-updated remaining session.
   */
  async onSessionDeleted(deletedSessionId: string): Promise<void> {
    const releasedTaskIds = this.cronLock.releaseBySession(deletedSessionId);
    if (releasedTaskIds.length === 0) return;

    for (const taskId of releasedTaskIds) {
      const tasks = this.cronTasks.load();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) continue; // task was also deleted

      const allSessions = await this.sessionStore.list();
      const candidates = allSessions.filter((s) => s.id !== deletedSessionId);
      if (candidates.length === 0) continue; // no sessions left, will be handled on next fire

      const replacement = candidates.sort(
        (a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime(),
      )[0];
      this.cronLock.acquire(taskId, replacement.id);
    }

    this.emit({ type: "cron_update", tasks: this.cronTasks.load() });
  }

  /** Called by CronScheduler when the task list changes (fire/edit/watch). */
  private onCronTasksChanged(tasks: CronTask[]): void {
    this.emit({ type: "cron_update", tasks });
  }

  private async enqueuePendingNotification(prompt: string, sessionId: string): Promise<void> {
    this.pendingQueue.push({ prompt, sessionId });
    if (this._runCount === 0) await this.drainPendingQueue();
  }

  private isCompactCommand(input: string): boolean {
    return input.trim().toLowerCase() === "/compact";
  }

  private async compactSession(sessionId: string): Promise<{ summary: string; removedMessages: number }> {
    const latestSettings = this.settingsStore.getAll();
    if (!latestSettings.isConfigured) {
      throw new Error("Model is not configured");
    }

    const provider = this.builder.getModelRegistry().createAndRegister(
      latestSettings.modelProvider as "anthropic" | "openai" | "deepseek",
      {
        apiKey: latestSettings.apiKey,
        baseUrl: latestSettings.baseUrl || undefined,
        modelId: latestSettings.modelId,
      },
    );
    const session = await this.sessionStore.get(sessionId);
    const messages = (session?.messages ?? []).filter((m) => m.role !== "system");
    const compactor = new ContextCompactor(provider);
    const result = await compactor.compactForHandoff(messages);
    await this.sessionStore.replaceMessages(sessionId, result.replacementMessages);
    await this.sessionStore.addEvent(sessionId, {
      type: "compacted",
      summary: result.summary,
      removedMessages: result.removedMessages,
    });
    return { summary: result.summary, removedMessages: result.removedMessages };
  }

  private async drainPendingQueue(): Promise<void> {
    if (this.queueDraining || this._runCount > 0) return;
    this.queueDraining = true;
    try {
      while (this.pendingQueue.length > 0 && this._runCount === 0) {
        const item = this.pendingQueue.shift()!;
        for await (const _ of this.run(item.prompt, item.sessionId || "")) {
          // events are emitted inside run()
        }
      }
    } finally {
      this.queueDraining = false;
    }
  }
}
