export const COLLABORATION_AGENTS = [
  "customer-agent",
  "codex",
  "claude-code",
  "opencode",
  "deepseek-harness",
] as const;
export type CollaborationAgent = (typeof COLLABORATION_AGENTS)[number];
export interface CollaborationMember {
  id: string;
  name: string;
  agentType: CollaborationAgent;
  role: string;
  model?: { id: string; providerID?: string };
  profileId?: string;
}
export interface CollaborationGroup {
  id: string;
  name: string;
  projectId?: string;
  cwd: string;
  ownerId: string;
  members: CollaborationMember[];
  maxParallel: number;
  createdAt: string;
  deletedAt?: string;
}
export type CreateCollaborationGroup = Omit<
  CollaborationGroup,
  "id" | "createdAt" | "deletedAt"
>;
export type CollaborationStatus =
  | "idle"
  | "running"
  | "waiting"
  | "stopping"
  | "stopped"
  | "completed"
  | "interrupted";
export interface CollaborationMessage {
  id: string;
  memberId?: string;
  kind: "user" | "owner" | "member" | "system" | "progress" | "question";
  content: string;
  createdAt: string;
  taskId?: string;
  question?: {
    id: string;
    options?: Array<{ label: string; description: string }>;
    resolved?: boolean;
  };
}
export interface CollaborationTask {
  id: string;
  memberId: string;
  title: string;
  instructions: string;
  dependsOn: string[];
  isolated: boolean;
  readOnly?: boolean;
  status:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "interrupted";
  sessionId?: string;
  cwd?: string;
  result?: string;
}
export interface CollaborationDiscussionState {
  id: string;
  groupId: string;
  /** Immutable execution configuration: group edits apply to new discussions. */
  groupSnapshot?: CollaborationGroup;
  title: string;
  status: CollaborationStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  generation: number;
  messages: CollaborationMessage[];
  tasks: CollaborationTask[];
  roles: Record<string, string>;
  sessions: Record<string, string>;
  ownerPending: boolean;
  planning: boolean;
  planningSessionId?: string;
  protocolFailures: number;
}
export type CollaborationDecision = {
  action: "dispatch" | "wait" | "ask" | "finish";
  /** Only finish may omit delivery, after a member has already replied this turn. */
  message: string;
  roles: Array<{ memberId: string; role: string }>;
  cancelTaskIds: string[];
  tasks: Array<
    Pick<
      CollaborationTask,
      | "id"
      | "memberId"
      | "title"
      | "instructions"
      | "dependsOn"
      | "isolated"
      | "readOnly"
    >
  >;
};
export interface CollaborationDiscussionSummary {
  id: string;
  groupId: string;
  title: string;
  status: CollaborationStatus;
  updatedAt: string;
}
export type CollaborationCommand =
  | { action: "groups" }
  | { action: "createGroup"; group: CreateCollaborationGroup }
  | { action: "group"; groupId: string }
  | { action: "updateGroup"; groupId: string; group: CreateCollaborationGroup }
  | { action: "deleteGroup"; groupId: string }
  | { action: "updateRole"; groupId: string; memberId: string; role: string }
  | { action: "discussions"; groupId: string }
  | { action: "createDiscussion"; groupId: string }
  | { action: "discussion"; discussionId: string; afterRevision?: number }
  | { action: "send"; discussionId: string; text: string; messageId: string }
  | { action: "stop" | "resume"; discussionId: string }
  | {
      action: "answer";
      discussionId: string;
      questionId: string;
      answer: string;
      selectedIndices?: number[];
    };

export class CollaborationError extends Error {
  constructor(
    message: string,
    readonly code = "INVALID_COLLABORATION",
  ) {
    super(message);
    this.name = "CollaborationError";
  }
}
