import type { SessionForkPoint } from "@agent/core";
import { type SDKMessage, type SDKActiveGoalMessage, type SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { type AgentEvent, type Message, type SessionHistoryQuery, type SessionQueryIndex, type ToolPermissionMode } from "@agent/core";
import type { AgentRuntimeAdapter, AgentWorkspace, CreateRuntimeSessionOptions, RuntimeHealth, RuntimeModelInfo, RuntimeQuestionAnswer, RuntimeRunOptions, UnifiedSessionDetail, UnifiedSessionSummary, WorkspacePage, WorkspaceQuery, WorkspaceSessionQuery } from "./types.js";
export declare class ClaudeSubagentTracker {
    private readonly tasks;
    consume(message: SDKMessage): AgentEvent[];
    hasActiveBackgroundTasks(): boolean;
    stopActive(): AgentEvent[];
    private update;
}
export declare class ClaudeRuntimeAdapter implements AgentRuntimeAdapter {
    readonly agentType: "claude-code";
    private readonly sessionRoot;
    private contextUsageRequestIndex;
    private readonly drafts;
    private readonly todoMcpBySession;
    private readonly workspaces;
    private readonly ownedSessions;
    private readonly activeQueries;
    private readonly activeInputs;
    private readonly pendingPermissions;
    private readonly abortedSessions;
    /** Transcript file paths are stable; the raw scan to find them is not free. */
    private readonly sessionPaths;
    /**
     * listSessions scans transcript contents for titles/prompts — too costly to
     * repeat on every history refresh. Cached entries are validated against the
     * transcript file's mtime+size, so appends still force a re-scan.
     */
    private readonly sessionInfoCache;
    /**
     * Occupancy detection spawns `lsof` and `claude agents` (~170ms combined);
     * cache the raw external set briefly. ownedSessions is applied fresh per call.
     */
    private occupancyCache;
    private readonly occupancyTtlMs;
    private readonly pagerStates;
    constructor(options?: {
        sessionRoot?: string;
        occupancyTtlMs?: number;
    });
    health(): Promise<RuntimeHealth>;
    /** Stable model aliases; explicit ids from settings profiles are passed through by the caller. */
    listModels(): Promise<RuntimeModelInfo[]>;
    discoverSessions(): Promise<UnifiedSessionSummary[]>;
    listWorkspaces(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    listWorkspaceSessions(workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    listWorkspaceSessionsByPath(cwd: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
    getSessionWatchPath(nativeSessionId: string): Promise<string | null>;
    /**
     * Source-paginated history over the session transcript.
     *
     * The ordinal space counts visible user/assistant messages of the converted
     * transcript — the same conversion the full read serves, so cursors,
     * historyIds and anchors stay consistent across pages and with the query
     * index. Tool results ride along with their assistant carrier and never
     * consume an ordinal.
     */
    getSessionPaged(nativeSessionId: string, query: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
    /** Query index over the transcript's visible messages (same ordinal space as getSessionPaged). */
    getQueryIndex(nativeSessionId: string): Promise<SessionQueryIndex | null>;
    fork(nativeSessionId: string, point?: SessionForkPoint): Promise<UnifiedSessionSummary>;
    renameSession(nativeSessionId: string, title: string): Promise<void>;
    delete(nativeSessionId: string): Promise<void>;
    create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
    restoreDraft(summary: UnifiedSessionSummary): void;
    run(nativeSessionId: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, runOptions?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    readonly supportsImageSteering = true;
    steer(nativeSessionId: string, input: string, _messageId?: string, images?: string[]): Promise<boolean>;
    abort(nativeSessionId: string): Promise<void>;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    dispose(): Promise<void>;
    private listAllSessions;
    private sessionDirOptions;
    /**
     * Converted transcript messages for native paging. Cached per session and
     * validated against the transcript's mtime+size; an append-only growth is
     * continued from the last consumed complete line instead of a full re-read.
     */
    private loadTranscriptMessages;
    /** Child agents can keep writing while the parent transcript is unchanged. */
    private pagerEvents;
    private subagentTranscriptStamp;
    private findSession;
    private cacheSessionInfo;
    private externalOccupancy;
    private recoverSubagentActivities;
    private findSessionPath;
    private toSummary;
    private readSessionCwd;
    private requestPermission;
    private readonly permissionEvents;
    private rejectPermissionsForSession;
}
export declare function claudeWorkspaceId(cwd: string): string;
export declare function classifyClaudePermission(toolName: string, input: Record<string, unknown>, cwd: string): import("@agent/core").ToolPermissionClassification;
export declare function requiresClaudeApproval(permissionMode: ToolPermissionMode, classification: ReturnType<typeof classifyClaudePermission>): boolean;
export declare function claudeHistoryToMessages(history: SessionMessage[], includeReasoning?: boolean): Message[];
export declare function claudeSdkMessageToEvents(message: SDKMessage | SDKActiveGoalMessage, hasStreamedText: boolean, hasStreamedReasoning?: boolean): AgentEvent[];
//# sourceMappingURL=claude-runtime-adapter.d.ts.map