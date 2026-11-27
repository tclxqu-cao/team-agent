import { AgentBuilder, SQLiteSessionStore, SQLiteMemoryStore, SQLiteMCPServerStore, SQLiteSkillStore, SQLitePluginStore, SQLiteUploadStore, SQLiteProjectStore, SQLiteAgentStore, SQLiteLSPServerStore, type ToolPermissionMode, MCPManager, type AgentEvent, type CronTask, type Session, type SettingsData, type TodoItem } from "@agent/core";
export declare function shouldInterruptPreviousRun(runCountIncludingCurrent: number): boolean;
export declare class AgentHost {
    private readonly harness;
    private agent;
    private builder;
    private readonly settingsStore;
    private readonly sessionStore;
    private readonly memoryStore;
    private readonly mcpStore;
    private readonly skillStore;
    private readonly pluginStore;
    private readonly uploadStore;
    private readonly projectStore;
    private readonly agentStore;
    private readonly lspStore;
    private readonly lspManager;
    private readonly subscribers;
    /** Current todo list for the active run (cleared at each top-level run) */
    private currentTodos;
    /** Session ID of the currently active top-level run (used to tag todo_update events) */
    private currentSessionId;
    /** Working directory tracked for sub-agent dispatch */
    private workingDirectory;
    /** Run-level ID used for the todos folder name (sessionId_runId) */
    private currentRunId;
    /** Cron task store (disk-backed) */
    private readonly cronTasks;
    /** Per-task session lock (file-backed) */
    private readonly cronLock;
    /** Cron scheduler */
    private readonly cronScheduler;
    /** Count of concurrent runs (supports interruption nesting) */
    private _runCount;
    /** MCP connection manager — handles server lifecycle */
    private readonly mcpConnectionManager;
    /** Queue of pending prompts enqueued by the cron scheduler */
    private pendingQueue;
    private queueDraining;
    /** Background sub-agents launched by dispatch_agent (non-blocking) */
    private readonly subAgentDispatcher;
    /** Manages ask_user question lifecycle */
    private readonly questionManager;
    private readonly toolPermissionGate;
    constructor(baseDir: string);
    /** Try to build the model provider from stored settings */
    private tryConfigureFromStore;
    /**
     * Hot-switch the active model profile without touching other settings.
     * Takes effect on the next agent run.
     */
    setActiveProfile(profileId: string): void;
    /** Save settings and reconfigure the builder */
    configure(settings: SettingsData): void;
    getSettings(): SettingsData & {
        activeAgentIds?: string[];
    };
    /** Toggle an agent in/out of the active agents list */
    toggleActiveAgent(agentId: string): string[];
    /** Replace the entire active agents list */
    setActiveAgentIds(ids: string[]): void;
    getBuilder(): AgentBuilder;
    getSessionStore(): SQLiteSessionStore;
    getMemoryStore(): SQLiteMemoryStore;
    getMCPStore(): SQLiteMCPServerStore;
    getSkillStore(): SQLiteSkillStore;
    getPluginStore(): SQLitePluginStore;
    getUploadStore(): SQLiteUploadStore;
    getAgentStore(): SQLiteAgentStore;
    getProjectStore(): SQLiteProjectStore;
    getLSPStore(): SQLiteLSPServerStore;
    /** Update the agent builder's working directory (takes effect on next run) */
    setWorkingDirectory(path: string): void;
    private setTodos;
    private persistTodos;
    getTodos(): TodoItem[];
    /**
     * Temporarily connect to an MCP server, list its tools, then disconnect.
     * Delegates to MCPConnectionManager.
     */
    probeServerTools(config: Parameters<typeof MCPManager.prototype.connectServer>[0]): Promise<Array<{
        name: string;
        description: string;
    }>>;
    /**
     * Connect all enabled MCP servers and register their tools into the builder's registry.
     * Delegates to MCPConnectionManager.
     */
    private connectMCPServers;
    /**
     * Register session-aware tools (todo + dispatch) on the given registry.
     * Must be called AFTER buildSync() so enabledTools filter doesn't remove them.
     *
     * Main agent: uses persistent shared this.currentTodos so todos survive across turns.
     * Sub-agents: use isolated per-dispatch todo state so they don't pollute the parent session.
     */
    private registerSessionTools;
    /**
     * List all skills by scanning the filesystem (all priority dirs) and merging
     * with SQLite. Filesystem discovery wins over SQLite-only records.
     * This is what the UI "/" autocomplete and SkillManager use.
     */
    listSkills(): Promise<Array<{
        name: string;
        description: string;
        filePath: string;
        source: string;
        enabled?: boolean;
    }>>;
    /**
     * Import a skill from a local path (directory or SKILL.md file).
     * Installs to ~/.agent/skills/<name>/ (global scope) and registers
     * immediately in the current builder so it is active this session.
     */
    importSkill(sourcePath: string): Promise<{
        name: string;
        description: string;
    }>;
    createSession(title: string, projectId?: string): Promise<Session>;
    setSessionPermissionMode(sessionId: string, mode: ToolPermissionMode): Promise<Session>;
    subscribe(fn: (event: AgentEvent & {
        _sid: string;
    }) => void): () => void;
    private emit;
    closeHarness(): void;
    getHarnessStatus(): import("@agent/core").HarnessServiceStatus;
    run(input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[]): AsyncIterable<AgentEvent>;
    private runInternal;
    /**
     * Steer a new user input into an already-running session without interrupting.
     * If an ask_user prompt is pending, the input answers it immediately so the
     * loop can continue while blocked in tool execution.
     * If the agent loop is active, the message is saved with name "__steer__" so
     * AgentLoop picks it up on its next iteration via the session checkpoint.
     * If no agent is running, it saves normally and returns false (caller should
     * start a new run via the run() method).
     */
    steerInput(input: string, sessionId: string, agentName?: string): Promise<boolean>;
    /**
     * Resolve a pending ask_user question with the user's answer.
     * Called from the renderer via IPC when the user selects an option or types a response.
     */
    answerQuestion(questionId: string, answer: string, selectedIndices?: number[]): boolean;
    abort(): void;
    createCronTask(cron: string, prompt: string, options?: Partial<Pick<CronTask, "recurring" | "label" | "sessionId">> & {
        agentId?: string;
    }): CronTask;
    pauseCronTask(id: string): CronTask | null;
    resumeCronTask(id: string): CronTask | null;
    deleteCronTask(id: string): boolean;
    deleteAllCronTasks(): void;
    listCronTasks(): CronTask[];
    /** Called when the agent loop starts/stops to gate queue draining (counter-based). */
    setRunning(v: boolean): void;
    /** Called by CronScheduler when a task fires. */
    private onCronFire;
    /**
     * Handle session deletion: release locks held by the session and
     * re-assign them to the most-recently-updated remaining session.
     */
    onSessionDeleted(deletedSessionId: string): Promise<void>;
    /** Called by CronScheduler when the task list changes (fire/edit/watch). */
    private onCronTasksChanged;
    private enqueuePendingNotification;
    private isCompactCommand;
    private compactSession;
    private drainPendingQueue;
}
//# sourceMappingURL=agent-host.d.ts.map