export const COLLABORATION_AGENTS = [
  "customer-agent",
  "codex",
  "claude-code",
  "opencode",
  "deepseek-harness",
] as const;
export type CollaborationAgent = (typeof COLLABORATION_AGENTS)[number];
export interface MonitoredSession {
  id: string;
  agentType: CollaborationAgent | "qoder" | "zcode" | "workbuddy";
  title: string;
  cwd: string;
  projectId?: string;
}
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
  /** References only: original sessions are never member execution sessions. */
  monitoring?: { supervisorId?: string; targets: MonitoredSession[] };
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
  /** 由代码确定性路由（chat 模式 @提及）生成，而非群主决策派发；完成时不唤醒群主。 */
  implicit?: boolean;
  /** 验收命令：任务成功后在任务目录执行，非零退出视为步骤失败。 */
  verification?: { command: string };
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
/** task-graph=群主规划编排；chat=@提及确定性路由，无 @ 静默。缺省视为 task-graph（存量讨论零迁移）。 */
export type CollaborationDiscussionMode = "task-graph" | "chat";
/** chat 模式 send 的路由结果，由服务层解析提及后传入，域内二次校验。 */
export interface MentionRoute {
  /** @群主：触发一轮群主规划。 */
  planning?: boolean;
  /** @其他成员：每个被提及成员一个隐式单成员任务。 */
  tasks?: CollaborationTask[];
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
  mode?: CollaborationDiscussionMode;
  /** 累计 token 用量（由运行时回报，缺失时不计入）。 */
  usage?: { inputTokens: number; outputTokens: number };
}
/** 运行时单次执行的用量回报；字段与各运行时的 TokenUsage 结构化兼容。 */
export interface CollabExecutionUsage {
  inputTokens: number;
  outputTokens: number;
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
      | "verification"
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
  | { action: "sessionCatalog"; query?: string; cursor?: string; limit?: number }
  | { action: "dashboard" }
  | { action: "supervisionAlerts" }
  | { action: "supervision" | "applySupervision"; groupId: string }
  | { action: "pauseSupervision"; groupId: string; paused: boolean }
  | { action: "answerSupervision"; groupId: string; incidentId: string; answer: string; selectedIndices?: number[] }
  | { action: "groups" }
  | { action: "createGroup"; group: CreateCollaborationGroup }
  | { action: "group"; groupId: string }
  | { action: "updateGroup"; groupId: string; group: CreateCollaborationGroup }
  | { action: "deleteGroup"; groupId: string }
  | { action: "updateRole"; groupId: string; memberId: string; role: string }
  | { action: "discussions"; groupId: string }
  | {
      action: "createDiscussion";
      groupId: string;
      mode?: CollaborationDiscussionMode;
    }
  | { action: "setMode"; discussionId: string; mode: CollaborationDiscussionMode }
  | { action: "discussion"; discussionId: string; afterRevision?: number }
  | { action: "send"; discussionId: string; text: string; messageId: string }
  | { action: "answerDecision"; discussionId: string; expectedRevision: number; answer: string; messageId: string }
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
