import type { AgentEvent } from "@agent/core";
import { type HarnessConnection } from "./deepseek-harness-client.js";
import { type NativeGoalMutation, type NativeSessionGoal } from "./native-session-goal.js";
import { type AgentRuntimeAdapter, type AgentWorkspace, type CreateRuntimeSessionOptions, type RuntimeHealth, type RuntimeModelInfo, type RuntimeQuestionAnswer, type RuntimeRunOptions, type UnifiedSessionDetail, type UnifiedSessionSummary, type WorkspacePage, type WorkspaceQuery, type WorkspaceSessionQuery } from "./types.js";
export declare class DeepSeekHarnessRuntimeAdapter implements AgentRuntimeAdapter {
    private readonly client;
    readonly agentType: "deepseek-harness";
    private readonly running;
    private readonly workspaces;
    private readonly interactions;
    constructor(client?: HarnessConnection);
    health(): Promise<RuntimeHealth>;
    listBackgroundJobs(nativeSessionId: string): Promise<import("./background-jobs.js").RuntimeBackgroundJob[]>;
    getBackgroundJobOutput(nativeSessionId: string, jobId: string): Promise<import("./background-jobs.js").RuntimeBackgroundJobOutput>;
    stopBackgroundJob(nativeSessionId: string, jobId: string): Promise<import("./background-jobs.js").RuntimeBackgroundJobStopResult>;
    private summary;
    discoverSessions(): Promise<UnifiedSessionSummary[]>;
    listWorkspaces(query?: WorkspaceQuery): Promise<WorkspacePage<AgentWorkspace>>;
    listWorkspaceSessions(workspaceId: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    listWorkspaceSessionsByPath(cwd: string, query?: WorkspaceSessionQuery): Promise<WorkspacePage<UnifiedSessionSummary>>;
    getSession(nativeSessionId: string): Promise<UnifiedSessionDetail>;
    private readSessionRow;
    private readQuestionProjections;
    create(options: CreateRuntimeSessionOptions): Promise<UnifiedSessionSummary>;
    renameSession(nativeSessionId: string, title: string): Promise<void>;
    setNativeMode(nativeSessionId: string, preset: string): Promise<UnifiedSessionSummary>;
    setNativePermissionPreset(nativeSessionId: string, preset: string): Promise<UnifiedSessionSummary>;
    private withLiveSession;
    getNativeGoal(nativeSessionId: string): Promise<NativeSessionGoal | null>;
    mutateNativeGoal(nativeSessionId: string, input: NativeGoalMutation): Promise<NativeSessionGoal | null>;
    run(nativeSessionId: string, input: string, images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent>;
    steer(nativeSessionId: string, input: string): Promise<boolean>;
    abort(nativeSessionId: string): Promise<void>;
    answerQuestion(questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean>;
    listModels(): Promise<RuntimeModelInfo[]>;
    dispose(): Promise<void>;
}
//# sourceMappingURL=deepseek-harness-runtime-adapter.d.ts.map