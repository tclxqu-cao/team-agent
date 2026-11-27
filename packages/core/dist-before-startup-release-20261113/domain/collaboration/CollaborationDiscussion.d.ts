import { type CollaborationDecision, type CollaborationDiscussionMode, type CollaborationDiscussionState, type CollaborationGroup, type CollaborationMessage, type CollaborationTask, type MentionRoute } from "./types.js";
export { validateCollaborationGroup, updateCollaborationRole } from "./CollaborationGroup.js";
/** A discussion is the consistency boundary for messages, roles and its task graph. */
export declare class CollaborationDiscussion {
    readonly state: CollaborationDiscussionState;
    readonly group: CollaborationGroup;
    constructor(state: CollaborationDiscussionState, group: CollaborationGroup);
    /** chat 模式下缺省视为 task-graph：存量讨论零迁移。 */
    get mode(): CollaborationDiscussionMode;
    setMode(mode: CollaborationDiscussionMode): void;
    append(message: CollaborationMessage): void;
    send(message: CollaborationMessage, route?: MentionRoute): void;
    /** chat 模式 @指派的隐式任务：群主不可被指派，成员与任务 ID 必须有效，验证后整批入队。 */
    private appendMentionTasks;
    applyDecision(decision: CollaborationDecision, notify: (content: string, kind: "owner" | "progress") => void): void;
    private currentTurnResults;
    readyTasks(): CollaborationTask[];
    settleTask(id: string, result: string, success: boolean): boolean;
    stop(): void;
    interrupt(): void;
    requestReplan(message: CollaborationMessage): void;
    resume(message: CollaborationMessage): void;
    pause(message: CollaborationMessage): void;
    finishStopping(): void;
    rememberSession(key: string, sessionId: string): void;
    /** 累计运行时回报的 token 用量；运行时未回报时调用方不调用本方法。 */
    recordUsage(usage: {
        inputTokens?: number;
        outputTokens?: number;
    }): void;
    beginPlanning(): void;
    planningSession(sessionId: string): void;
    finishPlanning(): void;
    rejectDecision(message: CollaborationMessage): void;
    resolveQuestion(questionId: string, answer?: CollaborationMessage): void;
    startTask(id: string): void;
    deferTask(id: string, isolated: boolean, reason?: string): void;
    attachTaskSession(id: string, sessionId: string, cwd: string, message: CollaborationMessage): void;
}
//# sourceMappingURL=CollaborationDiscussion.d.ts.map