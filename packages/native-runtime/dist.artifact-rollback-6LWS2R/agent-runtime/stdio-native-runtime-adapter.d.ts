import type { AgentEvent, Message } from "@agent/core";
import type { NativeAgentType } from "@agent/core";
import { type AgentRuntimeAdapter, type AgentWorkspace, type CreateRuntimeSessionOptions, type NativeSessionPermissions, type RuntimeHealth, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions, type UnifiedSessionDetail, type UnifiedSessionSummary, type WorkspacePage, type WorkspaceQuery, type WorkspaceSessionQuery } from "./types.js";
export interface NativeProtocolSession {
    id: string;
    title: string;
    cwd: string;
    workspaceIdentity?: string;
    created: string;
    updated: string;
    running?: boolean;
    /** A native client can retain ownership while its current turn is idle. */
    externallyOwned?: boolean;
    parentSessionId?: string;
    readOnly?: boolean;
    externalGuideSupported?: boolean;
    nativePermissions?: NativeSessionPermissions;
}
export interface NativeSessionProtocol {
    available(): Promise<void>;
    list(): Promise<NativeProtocolSession[]>;
    read(id: string): Promise<{
        session: NativeProtocolSession;
        messages: Message[];
        events?: AgentEvent[];
    }>;
    create(options: CreateRuntimeSessionOptions): Promise<NativeProtocolSession>;
    run(id: string, input: string, images?: string[], options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    steer?(id: string, input: string, messageId?: string): Promise<boolean>;
    abort(id: string): Promise<void>;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    listModels(): Promise<RuntimeModelInfo[]>;
    restoreDraft?(session: NativeProtocolSession): void;
    dispose(): Promise<void>;
}
/** Shared facade projection; each native client retains its own wire protocol and history. */
export declare class StdioNativeRuntimeAdapter implements AgentRuntimeAdapter {
    readonly agentType: NativeAgentType;
    private readonly label;
    private readonly client;
    private readonly running;
    private readonly drafts;
    constructor(agentType: NativeAgentType, label: string, client: NativeSessionProtocol);
    health(): Promise<RuntimeHealth>;
    protected summary(session: NativeProtocolSession): UnifiedSessionSummary;
    discoverSessions(): Promise<UnifiedSessionSummary[]>;
    private workspaceId;
    private workspaceSessions;
    private workspaceRoot;
    private workspaceCatalog;
    listWorkspaces(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    listWorkspaceSessions(workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    listWorkspaceSessionsByPath(cwd: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    private workspaceSessionPage;
    getSession(id: string): Promise<UnifiedSessionDetail>;
    create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
    restoreDraft(summary: UnifiedSessionSummary): void;
    run(id: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    abort(id: string): Promise<void>;
    answerQuestion(id: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    listModels(): Promise<RuntimeModelInfo[]>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=stdio-native-runtime-adapter.d.ts.map