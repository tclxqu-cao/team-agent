import type { SessionForkPoint } from "@agent/core";
import { type AgentEvent, type Message, type SessionHistoryQuery, type SessionQueryIndex, type SessionToolResultBody, type SessionToolResultRef, type ToolPermissionMode } from "@agent/core";
import { CodexAppServerClient, type RpcId, type RpcNotification } from "./codex-app-server-client.js";
import type { CodexAppServerLaunchMode } from "./codex-app-server-launcher.js";
import { CodexRolloutActivityReader, CodexRolloutCommentaryReader, CodexRolloutUserMessageReader } from "./codex-rollout-activity.js";
import type { AgentRuntimeAdapter, AgentWorkspace, CreateRuntimeSessionOptions, RuntimeHealth, RuntimeModelInfo, RuntimeQuestionAnswer, RuntimeRunOptions, UnifiedSessionDetail, UnifiedSessionSummary, WorkspacePage, WorkspaceQuery, WorkspaceSessionQuery } from "./types.js";
interface CodexDiscoveryClient {
    readonly pid?: number;
    readonly mode?: CodexAppServerLaunchMode | null;
    request<T>(method: string, params: unknown): Promise<T>;
    restart(): Promise<void>;
    dispose(): Promise<void>;
}
interface CodexTurn {
    id: string;
    status: string;
    items: CodexItem[];
    error?: {
        message?: string;
    } | null;
}
type CodexItem = Record<string, unknown> & {
    type: string;
    id?: string;
};
interface PendingApproval {
    requestId: RpcId;
    method: string;
    params: Record<string, unknown>;
    questionId: string;
}
export declare function codexThreadStatusToSessionStatus(statusType: unknown, ownedByUs?: boolean, externallyActive?: boolean): UnifiedSessionSummary["status"];
export declare function resolveCodexHome(environment?: NodeJS.ProcessEnv, homeDir?: string): string;
export declare class CodexRuntimeAdapter implements AgentRuntimeAdapter {
    readonly agentType: "codex";
    private readonly client;
    private readonly discoveryClient;
    private discoveryRefreshPromise;
    private lastStandaloneDiscoveryRestartAt;
    private readonly standaloneDiscoveryRestartIntervalMs;
    private readonly now;
    private readonly sessionRoot;
    private contextUsageRequestIndex;
    private readonly codexHome;
    private readonly codexExecutable;
    private readonly unavailableError?;
    private readonly platform;
    private readonly imageStorageRoot;
    private readonly rolloutActivityReader;
    private readonly rolloutCommentaryReader;
    private readonly rolloutUserMessageReader;
    private readonly agentMessagePhases;
    /** Flipped off permanently only when the app-server lacks the paginated turn protocol. */
    private nativePagingSupported;
    /** Progressive full-item hydration per session; the summary skeleton stays the ordinal source of truth. */
    private readonly pagedTurnItems;
    /** Final responses observed on disk before Codex publishes task_complete. */
    private readonly finalizingAnswers;
    private readonly activeQueues;
    private readonly activeTurnIds;
    private readonly locallyInterruptedTurnIds;
    private readonly unconfirmedInterruptedTurnIds;
    private readonly localInterruptionTimers;
    private readonly activeBrokerRunIds;
    private readonly activePermissionModes;
    private readonly activeGoalThreads;
    private readonly completedGoalTurns;
    private readonly lastGoalTurnText;
    private readonly goalTerminalStates;
    private readonly ownedThreads;
    private readonly pendingApprovals;
    private readonly asyncInputItems;
    private readonly pendingAsyncInputs;
    private readonly workspaces;
    private workspaceSnapshot;
    constructor(options?: {
        client?: CodexAppServerClient;
        discoveryClient?: CodexDiscoveryClient;
        sessionRoot?: string;
        imageStorageRoot?: string;
        rolloutActivityReader?: Pick<CodexRolloutActivityReader, "readMany">;
        rolloutCommentaryReader?: Pick<CodexRolloutCommentaryReader, "read">;
        rolloutUserMessageReader?: Pick<CodexRolloutUserMessageReader, "read">;
        codexExecutable?: string;
        environment?: NodeJS.ProcessEnv;
        homeDir?: string;
        platform?: NodeJS.Platform;
        unavailableError?: string;
        onApprovalResolved?: (questionId: string) => void;
        coreInlineImageBudgetBytes?: number;
        standaloneDiscoveryRestartIntervalMs?: number;
        now?: () => number;
    });
    private readonly onApprovalResolved?;
    private readonly coreInlineImageBudgetBytes;
    health(): Promise<RuntimeHealth>;
    /** Models offered by the connected codex account, as reported by the app-server. */
    listModels(): Promise<RuntimeModelInfo[]>;
    discoverSessions(): Promise<UnifiedSessionSummary[]>;
    listWorkspaces(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    listWorkspaceSessions(workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    listWorkspaceSessionsByPath(cwd: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
    /**
     * Source-paginated history over the native turn protocol.
     *
     * The ordinal space counts userMessage/agentMessage items only — the summary
     * view cannot see tool items, so tool-call carrier messages do not consume
     * ordinals (unlike the legacy full conversion). Every windowed query kind
     * (limit/before/after/anchor) and the query index MUST be served by this
     * path for the session; mixing with the legacy full-read space would
     * misalign cursors and anchors.
     */
    getSessionPaged(nativeSessionId: string, query: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
    getSessionToolResult(nativeSessionId: string, ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">): Promise<SessionToolResultBody>;
    /**
     * Query index over the same skeleton space as getSessionPaged, so search
     * pageTokens (anchors) decode against the revision the history pages serve.
     */
    getQueryIndex(nativeSessionId: string): Promise<SessionQueryIndex | null>;
    private nativeHistoryWindow;
    /** thread/turns/list answers newest-first; history needs rollout order. */
    private loadSummaryTurns;
    /**
     * Inline user-image attachments for a core history page within
     * CODEX_CORE_INLINE_IMAGE_BUDGET_BYTES, newest first. Everything older is
     * reported as an `omitted` attachment so the renderer can keep whatever it
     * already loaded and show a lightweight placeholder for the rest.
     */
    private loadCoreImageAttachments;
    private reconcileFinalizingAnswer;
    private selectNativeRange;
    /**
     * Fetch full items for the window's turns. The walk always starts at the
     * rollout tail (desc) and resumes from the stored cursor for deeper pages;
     * newly appended turns reset the cursor so the fresh tail is re-walked.
     */
    private hydrateTurnRange;
    /**
     * Ordinals follow the skeleton (user/agent items only). Within a turn:
     * user-role messages map to the turn's userMessage entries in order, and
     * the final answer assistant maps to the agentMessage entry. Tool-call and
     * reasoning carrier messages take no ordinal.
     */
    private assignNativeHistoryIds;
    private normalizePagedError;
    getSessionWatchPath(nativeSessionId: string): Promise<string | null>;
    create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
    renameSession(nativeSessionId: string, title: string): Promise<void>;
    fork(nativeSessionId: string, point?: SessionForkPoint): Promise<UnifiedSessionSummary>;
    archiveSession(nativeSessionId: string): Promise<void>;
    run(nativeSessionId: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    steer(nativeSessionId: string, input: string): Promise<boolean>;
    abort(nativeSessionId: string): Promise<void>;
    release(nativeSessionId: string): Promise<void>;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    dispose(): Promise<void>;
    private ensureAvailable;
    private refreshDiscoveryConnection;
    private ownedClientPids;
    private resolveSkillPath;
    private toSummary;
    private handleNotification;
    private consumeLocalInterruption;
    private scheduleLocalInterruptionConfirmation;
    private reconcileLocalInterruption;
    private scheduleLocalInterruptionReconcileRetry;
    private settleReconciledLocalInterruption;
    private isLocalInterruptionPending;
    private clearLocalInterruptionTimer;
    private clearUnconfirmedInterruptionIfTerminal;
    private reconcileAsyncInputs;
    private resolveAsyncInputReply;
    private clearAsyncInputs;
    private findWorkspace;
    private finishGoalQueueIfReady;
    private handleServerRequest;
}
export declare function parseExplicitSkillInvocation(input: string): {
    name: string;
    rest: string;
} | null;
export declare function codexTurnPermissionOptions(permissionMode: ToolPermissionMode, cwd: string): Record<string, unknown>;
export declare function codexApprovalResponse(pending: PendingApproval, answer: string): Record<string, unknown>;
export declare function normalizeCodexUserText(text: string): {
    content: string;
    rawContent?: string;
};
interface CodexMessageConversionOptions {
    toolResultMode?: "full" | "lazy";
    revision?: string;
    reasoningMaxBytes?: number;
    toolArgumentsMaxBytes?: number;
}
export declare function codexTurnsToMessages(turns: CodexTurn[], options?: CodexMessageConversionOptions): Promise<Message[]>;
export declare function codexReasoningNotificationToEvent(message: RpcNotification): Extract<AgentEvent, {
    type: "reasoning_summary_delta";
}> | null;
export declare function codexProgressNotificationToEvent(message: RpcNotification): AgentEvent | null;
export {};
//# sourceMappingURL=codex-runtime-adapter.d.ts.map