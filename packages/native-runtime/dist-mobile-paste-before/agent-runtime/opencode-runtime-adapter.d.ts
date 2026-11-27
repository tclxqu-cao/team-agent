import type { SessionForkPoint } from "@agent/core";
import { type AgentEvent, type Message, type SessionHistoryQuery, type SessionQueryIndex } from "@agent/core";
import type { Message as OpenCodeMessage, Part, Session, SessionStatus } from "@opencode-ai/sdk";
import { type OpenCodeServerEvent } from "./opencode-server-client.js";
import type { OpenCodeRuntimeClient } from "./opencode-v2-transport.js";
import type { AgentRuntimeAdapter, AgentWorkspace, CreateRuntimeSessionOptions, RuntimeHealth, RuntimeModelInfo, RuntimeQuestionAnswer, RuntimeRunOptions, UnifiedSessionDetail, UnifiedSessionSummary, WorkspacePage, WorkspaceQuery, WorkspaceSessionQuery } from "./types.js";
export interface OpenCodeServerPort {
    client(): Promise<OpenCodeRuntimeClient>;
    subscribe(listener: (event: OpenCodeServerEvent) => void, onFailure?: (error: Error) => void): () => void;
    dispose(): Promise<void>;
}
export declare class OpenCodeRuntimeAdapter implements AgentRuntimeAdapter {
    readonly agentType: "opencode";
    private readonly server;
    private readonly executable;
    private readonly unavailableError?;
    private readonly validateExecutable;
    private readonly onApprovalResolved?;
    private readonly dataRoot;
    private readonly activeRuns;
    private readonly ownedSessions;
    private readonly sessionDirectories;
    private readonly pendingPermissions;
    private readonly pendingQuestions;
    private readonly resolvedQuestionRequests;
    private readonly workspaces;
    private readonly pagerStates;
    private unsubscribe;
    private availabilityPromise;
    constructor(options?: {
        server?: OpenCodeServerPort;
        executable?: string;
        unavailableError?: string;
        environment?: NodeJS.ProcessEnv;
        dataRoot?: string;
        onApprovalResolved?: (questionId: string) => void;
    });
    health(): Promise<RuntimeHealth>;
    /** Models from the opencode server's own provider configuration, keyed by provider. */
    listModels(): Promise<RuntimeModelInfo[]>;
    discoverSessions(): Promise<UnifiedSessionSummary[]>;
    listWorkspaces(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    listWorkspaceSessions(workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    listWorkspaceSessionsByPath(directory: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
    /**
     * Source-paginated history over the opencode message list.
     *
     * The ordinal space counts visible user/assistant messages of the converted
     * history (tool results ride along and never consume an ordinal), with the
     * same cursor semantics as the other native runtimes. Conversion is cached
     * per message fingerprint so flipping pages skips re-mapping.
     */
    getSessionPaged(nativeSessionId: string, query: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
    /** Query index over the converted history (same ordinal space as getSessionPaged). */
    getQueryIndex(nativeSessionId: string): Promise<SessionQueryIndex | null>;
    private convertHistory;
    getSessionWatchPath(nativeSessionId: string): Promise<string | null>;
    create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
    fork(nativeSessionId: string, point?: SessionForkPoint): Promise<UnifiedSessionSummary>;
    run(nativeSessionId: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    abort(nativeSessionId: string): Promise<void>;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    dispose(): Promise<void>;
    private getClient;
    private ensureCompatibleExecutable;
    private resolveDirectory;
    private handleEvent;
    private handlePart;
    private handlePermission;
    private failRun;
    private handleFailure;
    private trackQuestion;
    private questionGroups;
    private resolveQuestionGroup;
    private markQuestionResolved;
    private getQuestionEvents;
}
export declare function openCodeSessionToSummary(session: Session, status: SessionStatus | undefined, ownedByUs?: boolean): UnifiedSessionSummary;
export declare function resolveOpenCodeDataRoot(environment?: NodeJS.ProcessEnv): string;
export declare function openCodeHistoryToMessages(history: Array<{
    info: OpenCodeMessage;
    parts: Part[];
}>): Message[];
//# sourceMappingURL=opencode-runtime-adapter.d.ts.map