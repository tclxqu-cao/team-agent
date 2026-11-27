import { type NativeGoalMutation, type NativeSessionGoal } from "./native-session-goal.js";
import type { SessionForkPoint } from "@agent/core";
import { type AgentEvent, type SessionGoalState, type SessionMessagePayload, type SessionHistoryQuery, type SessionQueryIndex, type SessionToolResultBody, type SessionToolResultRef, type ToolPermissionMode } from "@agent/core";
import { type CodexSessionCatalogRepository } from "./codex-session-disk-catalog.js";
import type { AgentRuntimeAdapter, AgentType, AgentWorkspace, CreateRuntimeSessionOptions, ImportedAgentWorkspaceRepository, ImportAgentWorkspaceResult, RuntimeHealth, RuntimeModelInfo, RuntimeQuestionAnswer, RuntimeRunOptions, UnifiedSessionDetail, UnifiedSessionSummary, WorkspacePage, WorkspaceQuery, WorkspaceSessionQuery } from "./types.js";
import { UnifiedSessionService } from "./unified-session-service.js";
type NativeAgentType = Exclude<AgentType, "customer-agent">;
export type NativeRuntimeController = "web" | "desktop";
export interface BrokerRunEvent {
    runId: string;
    sequence: number;
    event: AgentEvent;
}
export interface BrokerRunStart {
    runId: string;
    snapshotRevision: number;
    permissionMode: ToolPermissionMode;
}
export interface BrokerGoalEnqueueResult {
    state: SessionGoalState;
    started?: BrokerRunStart;
}
export interface BrokerMessageSteerResult {
    steered: boolean;
    state: SessionGoalState;
}
export interface BrokerQueuedMessageInput {
    sourceMessageId: string;
    content: string;
    messagePayload?: SessionMessagePayload;
}
export interface NativeRuntimeBrokerSnapshot {
    sessionId: string;
    runId: string | null;
    snapshotRevision: number;
    events: BrokerRunEvent[];
    controller: NativeRuntimeController | null;
}
export interface NativeRuntimeBrokerCallbacks {
    onApprovalResolved(questionId: string): void;
    importedWorkspaceRepository: ImportedAgentWorkspaceRepository;
    codexSessionCatalogRepository: CodexSessionCatalogRepository;
}
export type NativeRuntimeBrokerRuntimeFactory = (callbacks: NativeRuntimeBrokerCallbacks) => UnifiedSessionService;
export interface NativeRuntimeBrokerOptions {
    directory?: string;
    runtimeFactory?: NativeRuntimeBrokerRuntimeFactory;
    now?: () => number;
}
export declare class NativeRuntimeBrokerHost {
    readonly directory: string;
    private readonly state;
    private readonly runtime;
    private readonly activeExecutions;
    private readonly queueAdmissions;
    private readonly subscribers;
    private readonly localSubscribers;
    private readonly pendingCreations;
    private readonly cancellationConfirmationTimeouts;
    private readonly queryIndexCache;
    private server;
    private ownsSocket;
    private stopped;
    private readonly abortFallbackTimers;
    constructor(directory: string, runtime: UnifiedSessionService | NativeRuntimeBrokerRuntimeFactory, now?: () => number);
    get socketPath(): string;
    start(): Promise<void>;
    stop(): Promise<void>;
    health(): Promise<RuntimeHealth[]>;
    list(projectId?: string): Promise<UnifiedSessionSummary[]>;
    listWorkspaces(agentType: NativeAgentType, query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    importWorkspace(agentType: NativeAgentType, path: string, name?: string): Promise<ImportAgentWorkspaceResult>;
    listWorkspaceSessions(agentType: NativeAgentType, workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    refresh(projectId?: string): Promise<UnifiedSessionSummary[]>;
    create(options: CreateRuntimeSessionOptions & {
        agentType: NativeAgentType;
    }): Promise<UnifiedSessionSummary>;
    fork(id: string, point?: SessionForkPoint): Promise<UnifiedSessionSummary>;
    delete(sessionId: string): Promise<void>;
    get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
    getQueryIndex(id: string): Promise<SessionQueryIndex>;
    getSessionToolResult(id: string, ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">): Promise<SessionToolResultBody>;
    getSessionWatchPath(id: string): Promise<string | null>;
    startRun(sessionId: string, input: string, images?: string[], controller?: NativeRuntimeController, goalId?: string, agentIds?: string[], agentName?: string, runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">, admissionOptions?: {
        deferIfCodexRunning?: boolean;
    }): Promise<BrokerRunStart>;
    listModels(agentType: NativeAgentType): Promise<RuntimeModelInfo[]>;
    getGoals(sessionId: string, controller?: NativeRuntimeController): Promise<SessionGoalState>;
    enqueueGoal(sessionId: string, objective: string, sourceMessageId?: string, controller?: NativeRuntimeController): Promise<BrokerGoalEnqueueResult>;
    reorderGoals(sessionId: string, orderedIds: readonly string[]): SessionGoalState;
    enqueueMessage(sessionId: string, input: BrokerQueuedMessageInput, controller?: NativeRuntimeController): Promise<BrokerGoalEnqueueResult>;
    reorderMessages(sessionId: string, orderedIds: readonly string[]): SessionGoalState;
    updateMessage(sessionId: string, messageId: string, content: string, messagePayload?: SessionMessagePayload): SessionGoalState;
    cancelMessage(sessionId: string, messageId: string): SessionGoalState;
    steerMessage(sessionId: string, messageId: string): Promise<BrokerMessageSteerResult>;
    cancelGoal(sessionId: string, goalId: string, controller?: NativeRuntimeController): Promise<SessionGoalState>;
    subscribe(sessionId: string, afterSequence: number, listener: (event: BrokerRunEvent) => void): () => void;
    snapshot(sessionId: string, afterSequence?: number): NativeRuntimeBrokerSnapshot;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    abort(sessionId?: string): Promise<void>;
    release(sessionId: string): Promise<void>;
    steer(sessionId: string, input: string): Promise<boolean>;
    setNativePermissionPreset(sessionId: string, preset: string): Promise<UnifiedSessionSummary>;
    getNativeGoal(sessionId: string): Promise<NativeSessionGoal | null>;
    mutateNativeGoal(sessionId: string, mutation: NativeGoalMutation): Promise<NativeSessionGoal | null>;
    setPermissionMode(sessionId: string, permissionMode: ToolPermissionMode): UnifiedSessionSummary;
    handoff(sessionId: string, controller: NativeRuntimeController): NativeRuntimeBrokerSnapshot;
    private executeRun;
    private startQueueItemAfterSettling;
    private canResumeTimedOutQueue;
    private startQueueItem;
    private handleApprovalResolved;
    private mergePending;
    private handleSocket;
    private handleSocketLine;
    private handleRequest;
    private broadcast;
    private write;
}
/** Broker client used by the Web server and Electron main process. */
export declare class NativeRuntimeBrokerClient {
    private readonly options;
    private ensurePromise;
    constructor(options?: NativeRuntimeBrokerOptions);
    get directory(): string;
    health(): Promise<RuntimeHealth[]>;
    list(projectId?: string): Promise<UnifiedSessionSummary[]>;
    listWorkspaces(agentType: NativeAgentType, query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    importWorkspace(agentType: NativeAgentType, path: string, name?: string): Promise<ImportAgentWorkspaceResult>;
    listWorkspaceSessions(agentType: NativeAgentType, workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    refresh(projectId?: string): Promise<UnifiedSessionSummary[]>;
    create(options: CreateRuntimeSessionOptions & {
        agentType: NativeAgentType;
    }): Promise<UnifiedSessionSummary>;
    fork(id: string, point?: SessionForkPoint): Promise<UnifiedSessionSummary>;
    delete(id: string): Promise<void>;
    get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
    getQueryIndex(id: string): Promise<SessionQueryIndex>;
    getSessionToolResult(id: string, ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">): Promise<SessionToolResultBody>;
    getSessionWatchPath(id: string): Promise<string | null>;
    startRun(id: string, input: string, images?: string[], controller?: NativeRuntimeController, runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">): Promise<BrokerRunStart>;
    listModels(agentType: NativeAgentType): Promise<RuntimeModelInfo[]>;
    run(id: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, controller?: NativeRuntimeController, runOverrides?: Pick<RuntimeRunOptions, "model" | "reasoningEffort">): AsyncIterable<AgentEvent>;
    subscribe(id: string, afterSequence: number, listener: (event: BrokerRunEvent) => void): Promise<() => void>;
    snapshot(id: string, afterSequence?: number): Promise<NativeRuntimeBrokerSnapshot>;
    getGoals(id: string, controller?: NativeRuntimeController): Promise<SessionGoalState>;
    enqueueGoal(id: string, objective: string, sourceMessageId?: string, controller?: NativeRuntimeController): Promise<BrokerGoalEnqueueResult>;
    enqueueMessage(id: string, input: BrokerQueuedMessageInput, controller?: NativeRuntimeController): Promise<BrokerGoalEnqueueResult>;
    reorderGoals(id: string, orderedIds: readonly string[]): Promise<SessionGoalState>;
    reorderMessages(id: string, orderedIds: readonly string[]): Promise<SessionGoalState>;
    updateMessage(id: string, messageId: string, content: string, messagePayload?: SessionMessagePayload): Promise<SessionGoalState>;
    cancelMessage(id: string, messageId: string): Promise<SessionGoalState>;
    steerMessage(id: string, messageId: string): Promise<BrokerMessageSteerResult>;
    cancelGoal(id: string, goalId: string, controller?: NativeRuntimeController): Promise<SessionGoalState>;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    abort(id?: string): Promise<void>;
    release(id: string): Promise<void>;
    steer(id: string, input: string): Promise<boolean>;
    setPermissionMode(id: string, permissionMode: ToolPermissionMode): Promise<UnifiedSessionSummary>;
    setNativePermissionPreset(id: string, preset: string): Promise<UnifiedSessionSummary>;
    getNativeGoal(id: string): Promise<NativeSessionGoal | null>;
    mutateNativeGoal(id: string, mutation: NativeGoalMutation): Promise<NativeSessionGoal | null>;
    handoff(id: string, controller: NativeRuntimeController): Promise<NativeRuntimeBrokerSnapshot>;
    private request;
    private ensureHost;
    private requestRaw;
}
/** Adapter facade for a UnifiedSessionService that does not own native processes. */
export declare class BrokerRuntimeAdapter implements AgentRuntimeAdapter {
    readonly agentType: NativeAgentType;
    private readonly client;
    constructor(agentType: NativeAgentType, client: NativeRuntimeBrokerClient);
    health(): Promise<RuntimeHealth>;
    discoverSessions(): Promise<UnifiedSessionSummary[]>;
    listWorkspaces(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    importWorkspace(path: string, name?: string): Promise<ImportAgentWorkspaceResult>;
    listWorkspaceSessions(workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
    getSessionToolResult(nativeSessionId: string, ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">): Promise<SessionToolResultBody>;
    getSessionWatchPath(nativeSessionId: string): Promise<string | null>;
    create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
    fork(nativeSessionId: string, point?: SessionForkPoint): Promise<UnifiedSessionSummary>;
    delete(nativeSessionId: string): Promise<void>;
    run(nativeSessionId: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    listModels(): Promise<RuntimeModelInfo[]>;
    steer(nativeSessionId: string, input: string): Promise<boolean>;
    abort(nativeSessionId: string): Promise<void>;
    release(nativeSessionId: string): Promise<void>;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
}
export declare function createNativeRuntimeBrokerClient(options?: NativeRuntimeBrokerOptions): NativeRuntimeBrokerClient;
/**
 * Builds the direct runtime only for the process which successfully becomes
 * broker host. Every other process receives the broker adapter facade above.
 */
export declare function createNativeRuntimeBrokerHostRuntime(codexExecutable?: string, callbacks?: Partial<NativeRuntimeBrokerCallbacks>, opencodeExecutable?: string): UnifiedSessionService;
export declare function resolveNativeRuntimeDirectory(explicit?: string): string;
export declare function resolveNativeRuntimeSocketPath(directory: string, platform?: NodeJS.Platform): string;
export {};
//# sourceMappingURL=native-runtime-broker.d.ts.map