import type {
  CollaborationDiscussionState,
  CollaborationGroup,
} from "../types.js";

export const groupFixture = (): CollaborationGroup => ({
  id: "g",
  name: "协作群",
  cwd: "/project",
  ownerId: "owner",
  maxParallel: 3,
  createdAt: "2026-10-14",
  members: [
    { id: "owner", name: "总控", agentType: "codex", role: "" },
    { id: "a", name: "开发", agentType: "codex", role: "只负责实现" },
    { id: "b", name: "验证", agentType: "claude-code", role: "" },
  ],
});
export const stateFixture = (): CollaborationDiscussionState => ({
  id: "d",
  groupId: "g",
  title: "新讨论",
  status: "running",
  revision: 0,
  createdAt: "2026-10-14",
  updatedAt: "2026-10-14",
  generation: 0,
  messages: [],
  tasks: [],
  roles: {},
  sessions: {},
  ownerPending: false,
  planning: false,
  protocolFailures: 0,
});
