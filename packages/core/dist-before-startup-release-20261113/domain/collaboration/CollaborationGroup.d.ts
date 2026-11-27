import { type CollaborationGroup, type CollaborationDiscussionState, type CreateCollaborationGroup } from "./types.js";
export declare function validateCollaborationGroup(group: CollaborationGroup): void;
export declare function updateCollaborationRole(group: CollaborationGroup, memberId: string, role: string): CollaborationGroup;
/** Group configuration is separate from each discussion's execution history. */
export declare class CollaborationGroupAggregate {
    readonly state: CollaborationGroup;
    constructor(state: CollaborationGroup);
    assertAvailable(): void;
    private assertInactive;
    update(input: CreateCollaborationGroup, discussions: CollaborationDiscussionState[]): void;
    delete(discussions: readonly CollaborationDiscussionState[], at: string): void;
    assertCanDelete(discussions: readonly CollaborationDiscussionState[]): void;
}
//# sourceMappingURL=CollaborationGroup.d.ts.map