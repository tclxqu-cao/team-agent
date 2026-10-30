import {
  CollaborationError,
  type CollaborationDecision,
  type CollaborationDiscussionMode,
  type CollaborationDiscussionState,
  type CollaborationGroup,
  type CollaborationMessage,
  type CollaborationTask,
  type MentionRoute,
} from "./types.js";

export { validateCollaborationGroup, updateCollaborationRole } from "./CollaborationGroup.js";

/** A discussion is the consistency boundary for messages, roles and its task graph. */
export class CollaborationDiscussion {
  constructor(
    readonly state: CollaborationDiscussionState,
    readonly group: CollaborationGroup,
  ) {}

  /** chat 模式下缺省视为 task-graph：存量讨论零迁移。 */
  get mode(): CollaborationDiscussionMode {
    return this.state.mode ?? "task-graph";
  }

  setMode(mode: CollaborationDiscussionMode): void {
    this.state.mode = mode;
  }

  append(message: CollaborationMessage): void {
    if (!this.state.messages.some((m) => m.id === message.id))
      this.state.messages.push(message);
  }

  send(message: CollaborationMessage, route?: MentionRoute): void {
    if (this.state.messages.some((m) => m.id === message.id)) return;
    if (this.state.status === "stopping")
      throw new CollaborationError("正在停止，请稍后再发消息");
    this.append(message);
    if (this.state.title === "新讨论")
      this.state.title = message.content.slice(0, 50);
    if (route?.planning && route.tasks?.length)
      throw new CollaborationError("群主不能被 @ 指派，请直接提问以触发群主规划");
    // @成员恒为确定性路由，与讨论模式无关：被指派的成员直接执行，不打扰群主。
    if (route?.planning) {
      this.state.status = "running";
      this.state.ownerPending = true;
      this.state.protocolFailures = 0;
      return;
    }
    if (route?.tasks?.length) {
      this.appendMentionTasks(route.tasks);
      this.state.status = "running";
      return;
    }
    // 没有 @ 时模式才起作用：task-graph 交给群主，chat 静默记录。
    if (this.mode === "chat") return;
    this.state.status = "running";
    this.state.ownerPending = true;
    this.state.protocolFailures = 0;
  }

  /** chat 模式 @指派的隐式任务：群主不可被指派，成员与任务 ID 必须有效，验证后整批入队。 */
  private appendMentionTasks(tasks: CollaborationTask[]): void {
    for (const task of tasks) {
      if (task.memberId === this.group.ownerId)
        throw new CollaborationError("群主不能被 @ 指派，请直接提问以触发群主规划");
      if (
        !this.group.members.some((m) => m.id === task.memberId) ||
        this.state.tasks.some((t) => t.id === task.id)
      )
        throw new CollaborationError("任务成员不存在或任务 ID 重复");
    }
    const batch = new Set<string>();
    for (const task of tasks) {
      if (batch.has(task.id))
        throw new CollaborationError("任务成员不存在或任务 ID 重复");
      batch.add(task.id);
    }
    for (const task of tasks)
      this.state.tasks.push({
        ...task,
        dependsOn: [],
        status: "queued",
        implicit: true,
      });
  }

  applyDecision(
    decision: CollaborationDecision,
    notify: (content: string, kind: "owner" | "progress") => void,
  ): void {
    if (this.state.status !== "running") return;
    const members = new Set(this.group.members.map((m) => m.id));
    const existing = new Set(this.state.tasks.map((t) => t.id));
    const additions = new Set<string>();
    for (const task of decision.tasks) {
      if (
        !members.has(task.memberId) ||
        existing.has(task.id) ||
        additions.has(task.id)
      )
        throw new CollaborationError("任务成员不存在或任务 ID 重复");
      additions.add(task.id);
    }
    const graph = new Map(
      [...this.state.tasks, ...decision.tasks].map((t) => [t.id, t.dependsOn]),
    );
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const walk = (id: string): void => {
      if (visiting.has(id)) throw new CollaborationError("任务存在循环依赖");
      if (visited.has(id)) return;
      if (!graph.has(id)) throw new CollaborationError("任务依赖不存在");
      visiting.add(id);
      for (const dependency of graph.get(id)!) walk(dependency);
      visiting.delete(id);
      visited.add(id);
    };
    for (const id of graph.keys()) walk(id);
    for (const role of decision.roles)
      if (!members.has(role.memberId))
        throw new CollaborationError("角色指向未知成员");
    if (decision.action !== "dispatch" && decision.tasks.length)
      throw new CollaborationError("仅 dispatch 可以派发任务");
    if (decision.action === "dispatch" && !decision.tasks.length)
      throw new CollaborationError("派发至少需要一个任务");
    for (const id of decision.cancelTaskIds) {
      const task = this.state.tasks.find((t) => t.id === id);
      if (!task || task.status === "running")
        throw new CollaborationError("只能取消存在且未运行的任务");
    }
    const active = this.state.tasks.some(
      (t) =>
        (t.status === "queued" || t.status === "running") &&
        !decision.cancelTaskIds.includes(t.id),
    );
    if (decision.action === "finish" && active)
      throw new CollaborationError("仍有未完成任务，不能提前结束");
    if (decision.action === "wait" && !active)
      throw new CollaborationError("没有活动任务，请交付成果或向用户提问");
    const replies = this.currentTurnResults();
    if (
      !decision.message.trim() &&
      (decision.action !== "finish" || !replies.length)
    )
      throw new CollaborationError("尚无本轮成员成果，不能静默结束；请回复用户");
    for (const role of decision.roles) {
      if (!this.group.members.find((m) => m.id === role.memberId)!.role.trim())
        this.state.roles[role.memberId] = role.role;
    }
    for (const task of this.state.tasks)
      if (decision.cancelTaskIds.includes(task.id)) task.status = "cancelled";
    this.state.tasks.push(
      ...decision.tasks.map((task) => ({ ...task, status: "queued" as const })),
    );
    // Scheduling is progress. Only questions and final delivery are owner replies.
    const ownerResult = replies
      .filter((message) => message.memberId === this.group.ownerId)
      .at(-1);
    const repeatsOwnerResult =
      decision.action === "finish" &&
      ownerResult?.content.trim() === decision.message.trim();
    if (decision.message.trim() && !repeatsOwnerResult)
      notify(
        decision.message,
        decision.action === "dispatch" || decision.action === "wait"
          ? "progress"
          : "owner",
      );
    if (decision.action === "finish") this.state.status = "completed";
    if (decision.action === "ask") this.state.status = "waiting";
    this.state.protocolFailures = 0;
  }

  private currentTurnResults(): CollaborationMessage[] {
    let start = this.state.messages.length;
    while (start > 0 && this.state.messages[start - 1].kind !== "user") start--;
    return this.state.messages.slice(start).filter(
      (message) =>
        message.kind === "member" &&
        message.content.trim() &&
        this.state.tasks.some(
          (task) =>
            task.id === message.taskId &&
            task.memberId === message.memberId &&
            task.status === "completed" &&
            task.result === message.content,
        ),
    );
  }

  readyTasks(): CollaborationTask[] {
    const running = this.state.tasks.filter((t) => t.status === "running");
    let slots =
      this.group.maxParallel - running.length - Number(this.state.planning);
    const selected: CollaborationTask[] = [];
    for (const task of this.state.tasks) {
      if (slots <= 0) break;
      if (
        task.status !== "queued" ||
        !task.dependsOn.every(
          (id) =>
            this.state.tasks.find((t) => t.id === id)?.status === "completed",
        )
      )
        continue;
      const occupied = [...running, ...selected];
      if (occupied.some((t) => t.memberId === task.memberId)) continue;
      if (this.state.planning && task.memberId === this.group.ownerId) continue;
      // A shared directory is an exclusive resource. Independent worktrees can overlap.
      if (
        !task.isolated &&
        occupied.some((t) => !t.isolated && (!task.readOnly || !t.readOnly))
      )
        continue;
      selected.push(task);
      slots--;
    }
    return selected;
  }

  settleTask(id: string, result: string, success: boolean): boolean {
    const task = this.state.tasks.find((t) => t.id === id);
    if (!task || task.status !== "running") return false;
    task.result = result;
    task.status = success ? "completed" : "failed";
    if (this.state.status !== "running") return true;
    if (task.implicit) {
      // @指派任务由成员直接对用户负责；群里再无活动任务时回到静默待命。
      if (
        !this.state.tasks.some(
          (t) => t.status === "queued" || t.status === "running",
        ) &&
        !this.state.ownerPending
      )
        this.state.status = "idle";
      return true;
    }
    this.state.ownerPending = true;
    return true;
  }

  stop(): void {
    this.state.status = "stopping";
    this.state.ownerPending = false;
    this.state.generation++;
    for (const task of this.state.tasks)
      if (task.status === "queued") task.status = "cancelled";
  }

  interrupt(): void {
    this.state.generation++;
    this.state.planning = false;
    this.state.ownerPending = false;
    this.state.status = "interrupted";
    for (const task of this.state.tasks)
      if (task.status === "running") task.status = "interrupted";
  }

  requestReplan(message: CollaborationMessage): void {
    if (this.state.status !== "running") return;
    if (this.mode === "task-graph") this.state.ownerPending = true;
    this.append(message);
  }

  resume(message: CollaborationMessage): void {
    if (!["waiting", "interrupted", "stopped"].includes(this.state.status))
      throw new CollaborationError("此讨论无需继续");
    this.state.status = "running";
    if (this.mode === "chat") {
      // chat 模式没有群主重排：把被中断的 @指派任务重新排队即可。
      for (const task of this.state.tasks)
        if (task.status === "interrupted") task.status = "queued";
    } else {
      this.state.ownerPending = true;
    }
    this.state.protocolFailures = 0;
    this.append(message);
  }

  pause(message: CollaborationMessage): void {
    if (this.state.status !== "running") return;
    this.state.status = "waiting";
    this.append(message);
  }

  finishStopping(): void {
    this.state.status = "stopped";
    this.state.planning = false;
    for (const task of this.state.tasks)
      if (task.status === "running") task.status = "cancelled";
  }

  rememberSession(key: string, sessionId: string): void {
    this.state.sessions[key] = sessionId;
  }
  /** 累计运行时回报的 token 用量；运行时未回报时调用方不调用本方法。 */
  recordUsage(usage: {
    inputTokens?: number;
    outputTokens?: number;
  }): void {
    const total = (this.state.usage ??= { inputTokens: 0, outputTokens: 0 });
    total.inputTokens += usage.inputTokens ?? 0;
    total.outputTokens += usage.outputTokens ?? 0;
  }
  beginPlanning(): void {
    this.state.planning = true;
    this.state.ownerPending = false;
  }
  planningSession(sessionId: string): void {
    this.state.planningSessionId = sessionId;
  }
  finishPlanning(): void {
    this.state.planning = false;
  }

  rejectDecision(message: CollaborationMessage): void {
    this.state.protocolFailures++;
    this.append(message);
    if (this.state.protocolFailures <= 1) this.state.ownerPending = true;
    else this.state.status = "waiting";
  }

  resolveQuestion(questionId: string, answer?: CollaborationMessage): void {
    for (const message of this.state.messages)
      if (message.question?.id === questionId) message.question.resolved = true;
    if (answer) this.append(answer);
  }

  startTask(id: string): void {
    const task = this.state.tasks.find((task) => task.id === id);
    if (
      this.state.status !== "running" ||
      !task ||
      !this.readyTasks().some((task) => task.id === id)
    )
      throw new CollaborationError("步骤尚不能执行");
    task.status = "running";
  }

  deferTask(id: string, isolated: boolean, reason?: string): void {
    const task = this.state.tasks.find((task) => task.id === id)!;
    task.isolated = isolated;
    task.status = "queued";
    if (reason) task.result = reason;
  }

  attachTaskSession(
    id: string,
    sessionId: string,
    cwd: string,
    message: CollaborationMessage,
  ): void {
    const task = this.state.tasks.find((task) => task.id === id)!;
    task.sessionId = sessionId;
    task.cwd = cwd;
    this.append(message);
  }
}
