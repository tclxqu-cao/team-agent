import type { CollaborationRepository } from "../application/collaboration/ports.js";
import { type CollaborationDiscussionState, type CollaborationDiscussionSummary, type CollaborationGroup } from "../domain/collaboration/types.js";
export declare class SQLiteCollaborationRepository implements CollaborationRepository {
    private readonly db;
    constructor(baseDir: string);
    listGroups(): CollaborationGroup[];
    memberSessionIds(): Set<string>;
    saveGroup(group: CollaborationGroup): void;
    getGroup(id: string): CollaborationGroup | null;
    updateGroup(id: string, mutate: (group: CollaborationGroup, discussions: CollaborationDiscussionState[]) => void): CollaborationGroup;
    createDiscussion(state: CollaborationDiscussionState): void;
    getDiscussion(id: string): CollaborationDiscussionState | null;
    listDiscussions(groupId?: string): CollaborationDiscussionSummary[];
    /** Compact projection: dashboard reads must not hydrate complete chat histories. */
    dashboardDiscussions(): Array<CollaborationDiscussionSummary & {
        progress: string;
        runningCount: number;
        revision: number;
        sessions: Record<string, string>;
        questions: Array<{
            id: string;
            text: string;
            options?: Array<{
                label: string;
                description: string;
            }>;
        }>;
    }>;
    updateDiscussion(id: string, mutate: (state: CollaborationDiscussionState) => void): CollaborationDiscussionState;
    claim(id: string, owner: string, now: number, ttl: number): boolean;
    release(id: string, owner: string): void;
    claimWorkspace(cwd: string, holder: string, now: number, ttl: number, readOnly?: boolean): boolean;
    releaseWorkspace(cwd: string, holder: string): void;
}
//# sourceMappingURL=SQLiteCollaborationRepository.d.ts.map