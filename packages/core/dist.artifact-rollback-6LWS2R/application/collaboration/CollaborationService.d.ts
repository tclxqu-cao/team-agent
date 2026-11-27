import { type CollaborationCommand, type CollaborationDiscussionMode, type CollaborationDiscussionState, type CollaborationGroup, type CreateCollaborationGroup } from "../../domain/collaboration/types.js";
import type { CollaborationRepository, CollaborationRuntime } from "./ports.js";
/** Coordinates use cases through ports. No database, HTTP or native-agent dependencies. */
export declare class CollaborationService {
    readonly repository: CollaborationRepository;
    private readonly runtime;
    private readonly id;
    private readonly reportError;
    private readonly owner;
    private active;
    private ticking;
    private workspaces;
    private workspaceRetryAfter;
    constructor(repository: CollaborationRepository, runtime: CollaborationRuntime, id?: () => `${string}-${string}-${string}-${string}-${string}`, reportError?: (error: unknown) => void);
    group(id: string): CollaborationGroup;
    discussion(id: string): CollaborationDiscussionState;
    private discussionGroup;
    createGroup(input: CreateCollaborationGroup): CollaborationGroup;
    createDiscussion(groupId: string, mode?: CollaborationDiscussionMode): CollaborationDiscussionState;
    private message;
    private change;
    private deleteGroup;
    command(command: CollaborationCommand): Promise<unknown>;
    /** chat 模式的确定性路由：@群主=规划轮，@成员=隐式单成员任务，无 @=静默。 */
    private mentionRoute;
    private wake;
    /** The host calls tick even without viewers. Persisted leases prevent two hosts dispatching twice. */
    tick(): Promise<void>;
    private launch;
    private session;
    private progress;
    private plan;
    private work;
}
//# sourceMappingURL=CollaborationService.d.ts.map