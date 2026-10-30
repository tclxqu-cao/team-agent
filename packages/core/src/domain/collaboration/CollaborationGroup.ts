import {
  COLLABORATION_AGENTS,
  CollaborationError,
  type CollaborationGroup,
  type CollaborationDiscussionState,
  type CreateCollaborationGroup,
} from "./types.js";

export function validateCollaborationGroup(group: CollaborationGroup): void {
  if (!group.name.trim() || group.name.length > 100 || !group.cwd.trim())
    throw new CollaborationError("请填写群名和项目目录");
  if (group.members.length < 2 || group.members.length > 20)
    throw new CollaborationError("群需要 2 至 20 名成员（含群主）");
  const ids = new Set(group.members.map((m) => m.id));
  if (ids.size !== group.members.length || !ids.has(group.ownerId))
    throw new CollaborationError("群主和成员身份必须唯一");
  if (group.monitoring) {
    const { supervisorId, targets } = group.monitoring;
    if (supervisorId && !ids.has(supervisorId))
      throw new CollaborationError("监工必须是群成员");
    if (targets.length > 200 || new Set(targets.map(target => target.id)).size !== targets.length || targets.some(target => !target.id || target.id.length > 400 || !target.title || target.title.length > 1000 || !target.cwd || ![...COLLABORATION_AGENTS, "qoder", "zcode", "workbuddy"].includes(target.agentType)))
      throw new CollaborationError("关联会话无效或重复（最多 200 条）");
  }
  if (
    !Number.isInteger(group.maxParallel) ||
    group.maxParallel < 1 ||
    group.maxParallel > group.members.length
  )
    throw new CollaborationError("并行数必须在 1 和群人数之间");
  for (const member of group.members) {
    if (
      !member.id ||
      !member.name.trim() ||
      member.name.length > 100 ||
      member.role.length > 8000 ||
      !COLLABORATION_AGENTS.includes(member.agentType)
    )
      throw new CollaborationError("群成员配置无效");
  }
}

export function updateCollaborationRole(
  group: CollaborationGroup,
  memberId: string,
  role: string,
): CollaborationGroup {
  if (!group.members.some((member) => member.id === memberId))
    throw new CollaborationError("群成员不存在");
  const updated = {
    ...group,
    members: group.members.map((member) =>
      member.id === memberId ? { ...member, role } : member,
    ),
  };
  validateCollaborationGroup(updated);
  return updated;
}

/** Group configuration is separate from each discussion's execution history. */
export class CollaborationGroupAggregate {
  constructor(readonly state: CollaborationGroup) {}

  assertAvailable(): void {
    if (this.state.deletedAt)
      throw new CollaborationError("协作群已删除", "NOT_FOUND");
  }

  private assertInactive(
    discussions: readonly CollaborationDiscussionState[],
  ): void {
    this.assertAvailable();
    if (
      discussions.some(
        (d) =>
          ["running", "waiting", "stopping"].includes(d.status) ||
          d.planning ||
          d.tasks.some((t) => t.status === "running"),
      )
    )
      throw new CollaborationError(
        "群内仍有协作进行中，请先停止后再修改或删除",
        "GROUP_BUSY",
      );
  }

  update(
    input: CreateCollaborationGroup,
    discussions: CollaborationDiscussionState[],
  ): void {
    this.assertInactive(discussions);
    const next = {
      ...input,
      id: this.state.id,
      createdAt: this.state.createdAt,
    };
    validateCollaborationGroup(next);
    // Legacy discussions did not store their execution configuration.
    for (const discussion of discussions)
      discussion.groupSnapshot ??= structuredClone(this.state);
    Object.assign(this.state, next, { projectId: input.projectId, monitoring: input.monitoring });
  }

  delete(
    discussions: readonly CollaborationDiscussionState[],
    at: string,
  ): void {
    this.assertInactive(discussions);
    this.state.deletedAt = at;
  }
}
