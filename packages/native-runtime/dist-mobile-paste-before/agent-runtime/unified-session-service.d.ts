import type { SessionForkPoint } from "@agent/core";
import type { NativeGoalMutation, NativeSessionGoal } from "./native-session-goal.js";
import { type AgentEvent, type SessionHistoryQuery, type SessionQueryIndex, type SessionToolResultBody, type SessionToolResultRef } from "@agent/core";
import type { CodexSessionCompatibilityService } from "./codex-session-compatibility.js";
import type { AgentRuntimeAdapter, AgentType, AgentWorkspace, ImportedAgentWorkspaceRepository, ImportAgentWorkspaceResult, CreateRuntimeSessionOptions, RuntimeHealth, RuntimeModelInfo, RuntimeQuestionAnswer, RuntimeRunOptions, UnifiedSessionDetail, UnifiedSessionSummary, WorkspacePage, WorkspaceQuery, WorkspaceSessionQuery } from "./types.js";
interface ProjectLike {
    id: string;
    description: string;
}
export declare class UnifiedSessionService {
    private readonly listProjects;
    private readonly codexCompatibility?;
    private readonly adapters;
    private readonly workspaceIndex;
    private readonly activeSessionIds;
    private healthCache;
    private discoveryPromise;
    private readonly detailCache;
    private readonly queryIndexCache;
    constructor(adapters: AgentRuntimeAdapter[], listProjects: () => Promise<ProjectLike[]>, importedWorkspaces?: ImportedAgentWorkspaceRepository, codexCompatibility?: CodexSessionCompatibilityService | undefined);
    listWorkspaces(agentType: AgentType, query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    listWorkspaceSessions(agentType: AgentType, workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    importWorkspace(agentType: AgentType, path: string, name?: string): Promise<ImportAgentWorkspaceResult>;
    health(): Promise<RuntimeHealth[]>;
    getCachedHealth(): RuntimeHealth[];
    /** Models offered by one runtime's own connection (codex account, opencode providers, …). */
    listModels(agentType: AgentType): Promise<RuntimeModelInfo[]>;
    list(projectId?: string): Promise<UnifiedSessionSummary[]>;
    refresh(projectId?: string): Promise<UnifiedSessionSummary[]>;
    invalidate(id: string): void;
    invalidateCodexCompatibility(): void;
    private discoverAll;
    private performDiscovery;
    listChildren(parentId: string): Promise<UnifiedSessionSummary[]>;
    get(id: string, query?: SessionHistoryQuery): Promise<UnifiedSessionDetail>;
    /**
     * Adapter-native windowed history (e.g. Codex turn paging). The adapter owns
     * ONE self-consistent ordinal space for the session — latest/before/after/
     * anchor pages and the query index all come from it, so cursors, historyIds
     * and anchors cross-reference correctly. The hybrid detail is deliberately
     * NOT stored in the full detail cache: tool bodies outside the window are
     * absent, and the legacy cache is keyed by a different ordinal space.
     */
    getPagedDetail(id: string, query: SessionHistoryQuery): Promise<UnifiedSessionDetail | null>;
    getQueryIndex(id: string): Promise<SessionQueryIndex>;
    getSessionToolResult(id: string, ref: Pick<SessionToolResultRef, "turnId" | "itemId" | "revision">): Promise<SessionToolResultBody>;
    getQueryIndexNative(id: string): Promise<SessionQueryIndex | null>;
    getUnpaginated(id: string, preferCache?: boolean): Promise<UnifiedSessionDetail>;
    getSessionWatchPath(id: string): Promise<string | null>;
    create(options: CreateRuntimeSessionOptions & {
        agentType: AgentType;
    }): Promise<UnifiedSessionSummary>;
    restoreDrafts(summaries: readonly UnifiedSessionSummary[]): void;
    fork(id: string, point?: SessionForkPoint): Promise<UnifiedSessionSummary>;
    rename(id: string, title: string): Promise<void>;
    setNativePermissionPreset(id: string, preset: string): Promise<UnifiedSessionSummary>;
    getNativeGoal(id: string): Promise<NativeSessionGoal | null>;
    mutateNativeGoal(id: string, mutation: NativeGoalMutation): Promise<NativeSessionGoal | null>;
    run(id: string, input: string, images?: string[], agentIds?: string[], agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    abort(id?: string): Promise<void>;
    release(id: string): Promise<void>;
    steer(id: string, input: string): Promise<boolean>;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    archive(id: string): Promise<void>;
    delete(id: string): Promise<void>;
    dispose(): Promise<void>;
    agentTypeFor(id: string): AgentType;
    private resolveAdapter;
    private recordFailure;
    private cacheDetail;
}
export declare function shouldReuseSessionDetailCache(query?: SessionHistoryQuery): boolean;
export {};
//# sourceMappingURL=unified-session-service.d.ts.map