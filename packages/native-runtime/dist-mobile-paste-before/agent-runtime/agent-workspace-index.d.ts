import type { AgentRuntimeAdapter, AgentType, AgentWorkspace, ImportedAgentWorkspaceRepository, ImportAgentWorkspaceResult, UnifiedSessionSummary, WorkspacePage, WorkspaceQuery, WorkspaceSessionQuery } from "./types.js";
export declare const CODEX_RECENT_WORKSPACE_ID = "codex:recent";
export interface SessionCatalog {
    byWorkspace: Map<string, UnifiedSessionSummary[]>;
    watermark: string | null;
}
export declare function workspacePageSize(limit?: number): number;
export declare function encodeOffsetCursor(offset: number): string;
export declare function decodeOffsetCursor(cursor?: string | null): number;
export declare function paginateByOffset<T>(data: readonly T[], query?: {
    cursor?: string | null;
    limit?: number;
}, watermark?: string | null): WorkspacePage<T>;
export declare function normalizeAgentWorkspacePath(value: string, platform?: NodeJS.Platform): string;
export declare function importedWorkspaceId(agentType: AgentType, normalizedPath: string): string;
/** Application service that keeps workspace discovery isolated per Agent. */
export declare class AgentWorkspaceIndexService {
    private readonly importedWorkspaces?;
    private readonly platform;
    private readonly supplementCodexSessions?;
    private readonly adapters;
    private readonly workspaceCache;
    private readonly workspaceRequests;
    private readonly sessionCache;
    private readonly sessionRequests;
    private codexSessionCatalog;
    private codexSessionCatalogRequest;
    private readonly codexDirectSessions;
    private codexSessionCatalogGeneration;
    constructor(adapters: readonly AgentRuntimeAdapter[], importedWorkspaces?: ImportedAgentWorkspaceRepository | undefined, platform?: NodeJS.Platform, supplementCodexSessions?: ((primary: readonly UnifiedSessionSummary[]) => UnifiedSessionSummary[]) | undefined);
    listWorkspaces(agentType: AgentType, query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    importWorkspace(agentType: AgentType, path: string, name?: string): Promise<ImportAgentWorkspaceResult>;
    listWorkspaceSessions(agentType: AgentType, workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    invalidate(agentType: AgentType, workspaceId?: string): void;
    private clearSessionCache;
    private deleteSessionCacheEntries;
    private resetCodexSessionCatalog;
    private requireWorkspaceAdapter;
    private loadWorkspaceCatalog;
    private listCodexWorkspaceSessions;
    private rememberCodexDirectSessions;
    private getCodexSessionCatalog;
    private loadCodexSessionCatalog;
    private listImportedWorkspaceSessions;
}
export declare function classifyCodexSessions(sessions: readonly UnifiedSessionSummary[], workspaces: readonly AgentWorkspace[], platform?: NodeJS.Platform, workspaceAliases?: ReadonlyMap<string, string>): SessionCatalog;
//# sourceMappingURL=agent-workspace-index.d.ts.map