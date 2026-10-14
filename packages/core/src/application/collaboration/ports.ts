import type {
  CollaborationDiscussionState,
  CollaborationDiscussionSummary,
  CollaborationGroup,
  CollaborationMember,
} from "../../domain/collaboration/types.js";

export interface CollaborationRepository {
  listGroups(): CollaborationGroup[];
  saveGroup(group: CollaborationGroup): void;
  getGroup(id: string): CollaborationGroup | null;
  /** Atomically read and mutate a group together with its discussion configurations. */
  updateGroup(
    id: string,
    mutate: (
      group: CollaborationGroup,
      discussions: CollaborationDiscussionState[],
    ) => void,
  ): CollaborationGroup;
  createDiscussion(state: CollaborationDiscussionState): void;
  getDiscussion(id: string): CollaborationDiscussionState | null;
  listDiscussions(groupId?: string): CollaborationDiscussionSummary[];
  updateDiscussion(
    id: string,
    mutate: (state: CollaborationDiscussionState) => void,
  ): CollaborationDiscussionState;
  claim(id: string, owner: string, now: number, ttl: number): boolean;
  release(id: string, owner: string): void;
  claimWorkspace(
    cwd: string,
    holder: string,
    now: number,
    ttl: number,
    readOnly?: boolean,
  ): boolean;
  releaseWorkspace(cwd: string, holder: string): void;
}
export interface CollaborationProgress {
  text: string;
  question?: {
    id: string;
    options?: Array<{ label: string; description: string }>;
  };
  resolvedQuestionId?: string;
}
export interface CollaborationExecution {
  group: CollaborationGroup;
  member: CollaborationMember;
  sessionId: string;
  prompt: string;
  signal: AbortSignal;
}
export interface CollaborationRuntime {
  prepareWorkspace(
    group: CollaborationGroup,
    discussionId: string,
    taskId: string,
  ): Promise<{ cwd: string; isolated: boolean; note?: string }>;
  createSession(
    group: CollaborationGroup,
    member: CollaborationMember,
    cwd: string,
  ): Promise<string>;
  execute(
    input: CollaborationExecution,
    onProgress: (progress: CollaborationProgress) => void,
  ): Promise<{ text: string }>;
  abort(sessionId: string): Promise<void>;
  answer(
    sessionId: string,
    questionId: string,
    answer: string,
    selectedIndices?: number[],
  ): Promise<boolean>;
}
