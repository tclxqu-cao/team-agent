import { AgentBuilder, type AgentEvent, type DispatchResult, type SpawnAgentInput, type SQLiteAgentStore, type SQLiteSessionStore, type SQLiteSettingsStore, type SQLiteMemoryStore, type ToolPermissionGate } from "@agent/core";
/** Callback to register session-level tools on a builder */
export type RegisterSessionToolsFn = (builder: AgentBuilder, sessionId: string, allowDispatch?: boolean) => void;
/** Callback to emit an event to subscribers */
export type EmitFn = (event: AgentEvent, sid?: string) => void;
export interface DynamicTeamRuntimeOptions {
    maxWorkers: number;
    maxParallel: number;
    workerTimeoutMs: number;
    runId: string;
    profileId?: string;
    enabledTools?: string[];
    enabledSkills?: string[];
    enabledMCPServers?: string[];
    memoryEnabled?: boolean;
    prepareBuilder?: (builder: AgentBuilder, capabilities: {
        profileId?: string;
        enabledTools: string[];
        enabledSkills: string[];
        enabledMCPServers: string[];
        memoryEnabled?: boolean;
    }) => Promise<{
        applySkills(): Promise<void>;
        close(): Promise<void>;
    }>;
}
/**
 * Manages sub-agent dispatch, execution, and lifecycle.
 * Extracted from AgentHost to isolate multi-agent coordination concerns.
 */
export declare class SubAgentDispatcher {
    private readonly agentStore;
    private readonly sessionStore;
    private readonly settingsStore;
    private readonly memoryStore;
    private readonly registerSessionTools;
    private readonly emit;
    private readonly toolPermissionGate?;
    private readonly dynamicTeam?;
    /** Background sub-agents launched by dispatch_agent (non-blocking) */
    private runningSubAgents;
    private completedSubAgents;
    private spawnedDynamicAgents;
    constructor(agentStore: SQLiteAgentStore, sessionStore: SQLiteSessionStore, settingsStore: SQLiteSettingsStore, memoryStore: SQLiteMemoryStore, registerSessionTools: RegisterSessionToolsFn, emit: EmitFn, toolPermissionGate?: ToolPermissionGate | undefined, dynamicTeam?: DynamicTeamRuntimeOptions | undefined);
    dynamicTeamEnabled(): boolean;
    /**
     * Launch a sub-agent in the background and return immediately.
     * The sub-agent runs asynchronously; its result is stored in runningSubAgents.
     * Call wait() or the wait_agent tool to await the result.
     * When complete, a mailbox notification is injected into the parent session.
     */
    dispatch(agentName: string, task: string, parentSessionId: string): Promise<DispatchResult>;
    /** Create a run-scoped temporary child Agent without writing AgentStore. */
    spawn(input: SpawnAgentInput, parentSessionId: string): Promise<DispatchResult>;
    /**
     * Wait for a background sub-agent to complete.
     * Looks up the running promise and awaits it with an optional timeout.
     */
    wait(subSessionId: string, timeoutMs?: number): Promise<DispatchResult>;
    /** Wait until all current children reach a terminal state. */
    waitForIdle(timeoutMs: number): Promise<DispatchResult[]>;
    /** Abort all background sub-agents (called when parent turn is interrupted) */
    abortAll(): void;
    private failedSpawn;
    private track;
    /**
     * Execute the sub-agent loop and persist results.
     * Runs as a background promise — does NOT block dispatch().
     */
    private runSubAgentInBackground;
    /**
     * Inject a mailbox notification message into the parent session so the main agent
     * can see the sub-agent's completion/failure on its next turn.
     * Uses a special name "__mailbox__" so the AgentLoop can distinguish these.
     */
    private injectMailboxNotification;
}
//# sourceMappingURL=sub-agent-dispatcher.d.ts.map