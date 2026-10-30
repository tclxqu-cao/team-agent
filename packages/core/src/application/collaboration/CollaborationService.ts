import {
  CollaborationDiscussion,
  updateCollaborationRole,
  validateCollaborationGroup,
} from "../../domain/collaboration/CollaborationDiscussion.js";
import { CollaborationGroupAggregate } from "../../domain/collaboration/CollaborationGroup.js";
import { parseCollaborationDecision } from "../../domain/collaboration/coordinator-protocol.js";
import { parseMentions, stripMentions } from "../../domain/collaboration/mention-routing.js";
import {
  CollaborationError,
  type CollaborationCommand,
  type CollaborationDiscussionMode,
  type CollaborationDiscussionState,
  type CollaborationGroup,
  type CollaborationMessage,
  type CollaborationTask,
  type CreateCollaborationGroup,
  type MentionRoute,
} from "../../domain/collaboration/types.js";
import type {
  CollaborationProgress,
  CollaborationRepository,
  CollaborationRuntime,
} from "./ports.js";
import {
  collaborationOwnerPrompt,
  collaborationWorkerPrompt,
} from "./prompts.js";

interface ActiveDiscussion {
  generation: number;
  jobs: Map<string, AbortController>;
}

/** Coordinates use cases through ports. No database, HTTP or native-agent dependencies. */
export class CollaborationService {
  private readonly owner: string;
  private active = new Map<string, ActiveDiscussion>();
  private ticking = false;
  private workspaces = new Map<string, { cwd: string; readOnly: boolean }>();
  private workspaceRetryAfter = new Map<string, number>();
  constructor(
    readonly repository: CollaborationRepository,
    private readonly runtime: CollaborationRuntime,
    private readonly id = () => crypto.randomUUID(),
    private readonly reportError: (error: unknown) => void = () => {},
  ) {
    this.owner = this.id();
  }

  group(id: string): CollaborationGroup {
    const group = this.repository.getGroup(id);
    if (!group) throw new CollaborationError("协作群不存在", "NOT_FOUND");
    new CollaborationGroupAggregate(group).assertAvailable();
    return group;
  }
  discussion(id: string): CollaborationDiscussionState {
    const state = this.repository.getDiscussion(id);
    if (!state) throw new CollaborationError("群聊记录不存在", "NOT_FOUND");
    this.group(state.groupId);
    return state;
  }
  private discussionGroup(
    state: CollaborationDiscussionState,
  ): CollaborationGroup {
    return state.groupSnapshot ?? this.group(state.groupId);
  }
  createGroup(input: CreateCollaborationGroup): CollaborationGroup {
    const group = {
      ...input,
      id: this.id(),
      createdAt: new Date().toISOString(),
    };
    validateCollaborationGroup(group);
    this.repository.saveGroup(group);
    return group;
  }
  createDiscussion(
    groupId: string,
    mode: CollaborationDiscussionMode = "task-graph",
  ): CollaborationDiscussionState {
    const group = this.group(groupId);
    const now = new Date().toISOString();
    const state: CollaborationDiscussionState = {
      id: this.id(),
      groupId,
      groupSnapshot: structuredClone(group),
      title: "新讨论",
      status: "idle",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      generation: 0,
      messages: [],
      tasks: [],
      roles: {},
      sessions: {},
      ownerPending: false,
      planning: false,
      protocolFailures: 0,
      mode,
    };
    this.repository.createDiscussion(state);
    return state;
  }
  private message(
    content: string,
    kind: CollaborationMessage["kind"],
    memberId?: string,
    taskId?: string,
  ): CollaborationMessage {
    return {
      id: this.id(),
      content,
      kind,
      memberId,
      taskId,
      createdAt: new Date().toISOString(),
    };
  }
  private change(
    id: string,
    mutate: (domain: CollaborationDiscussion) => void,
  ): CollaborationDiscussionState {
    const group = this.discussionGroup(this.discussion(id));
    return this.repository.updateDiscussion(id, (state) =>
      mutate(new CollaborationDiscussion(state, group)),
    );
  }
  async command(command: CollaborationCommand): Promise<unknown> {
    switch (command.action) {
      case "groups":
        return this.repository.listGroups();
      case "group":
        return this.group(command.groupId);
      case "updateGroup":
        return this.repository.updateGroup(
          command.groupId,
          (group, discussions) =>
            new CollaborationGroupAggregate(group).update(
              command.group,
              discussions,
            ),
        );
      case "deleteGroup":
        this.repository.updateGroup(command.groupId, (group, discussions) =>
          new CollaborationGroupAggregate(group).delete(
            discussions,
            new Date().toISOString(),
          ),
        );
        return { deleted: true, groupId: command.groupId };
      case "updateRole": {
        const group = updateCollaborationRole(
          this.group(command.groupId),
          command.memberId,
          command.role,
        );
        this.repository.saveGroup(group);
        const member = group.members.find(
          (member) => member.id === command.memberId,
        )!;
        for (const item of this.repository.listDiscussions(group.id))
          this.change(item.id, (domain) => {
            if (
              domain.state.groupSnapshot?.members.some(
                (m) => m.id === command.memberId,
              )
            )
              domain.state.groupSnapshot = updateCollaborationRole(
                domain.state.groupSnapshot,
                command.memberId,
                command.role,
              );
            domain.requestReplan(
              this.message(
                `${member.name}的职责已更新，下次安排时生效。`,
                "system",
              ),
            );
          });
        return group;
      }
      case "createGroup":
        return this.createGroup(command.group);
      case "discussions":
        this.group(command.groupId);
        return this.repository.listDiscussions(command.groupId);
      case "createDiscussion":
        return this.createDiscussion(command.groupId, command.mode);
      case "setMode":
        return this.change(command.discussionId, (domain) =>
          domain.setMode(command.mode),
        );
      case "discussion": {
        const state = this.discussion(command.discussionId);
        return state.revision === command.afterRevision
          ? { unchanged: true, revision: state.revision }
          : state;
      }
      case "answerDecision": {
        if (!command.answer.trim() || command.answer.length > 10000 || !command.messageId || command.messageId.length > 200)
          throw new CollaborationError("决策答复不能为空或过长");
        const state = this.change(command.discussionId, domain => {
          if (domain.state.messages.some(message => message.id === command.messageId)) return;
          if (domain.state.status !== "waiting" || domain.state.revision !== command.expectedRevision || domain.state.messages.some(message => message.question && !message.question.resolved))
            throw new CollaborationError("该决策已变化或已处理，请刷新群聊");
          domain.send({ ...this.message(command.answer, "user"), id: command.messageId }, { planning: true });
        });
        this.wake();
        return state;
      }
      case "send": {
        if (
          !command.text.trim() ||
          command.text.length > 100000 ||
          !command.messageId ||
          command.messageId.length > 200
        )
          throw new CollaborationError("消息不能为空或过长");
        const message = {
          ...this.message(command.text, "user"),
          id: command.messageId,
        };
        const current = this.discussion(command.discussionId);
        // @ 提及恒生效；模式只决定无 @ 时的行为（chat 静默 / task-graph 交给群主）。
        const route = this.mentionRoute(
          command.text,
          this.discussionGroup(current),
        );
        const state = this.change(command.discussionId, (domain) =>
          domain.send(message, route),
        );
        this.wake();
        return state;
      }
      case "stop": {
        const state = this.change(command.discussionId, (domain) =>
          domain.stop(),
        );
        this.wake();
        return state;
      }
      case "resume": {
        const state = this.change(command.discussionId, (domain) => {
          domain.resume(
            this.message(
              "继续协作：请先核对之前中断或停止的任务结果，再安排后续工作。",
              "system",
            ),
          );
        });
        this.wake();
        return state;
      }
      case "answer": {
        const state = this.discussion(command.discussionId);
        const question = state.messages.find(
          (m) => m.question?.id === command.questionId && !m.question.resolved,
        );
        if (!question || !question.memberId || !command.answer.trim())
          throw new CollaborationError("待回答的问题不存在");
        const sessionId = question.taskId
          ? state.tasks.find((t) => t.id === question.taskId)?.sessionId
          : state.planningSessionId;
        if (
          !sessionId ||
          !(await this.runtime.answer(
            sessionId,
            command.questionId,
            command.answer,
            command.selectedIndices,
          ))
        )
          throw new CollaborationError("问题已失效，请核对成员运行状态");
        return this.change(state.id, (domain) =>
          domain.resolveQuestion(
            command.questionId,
            this.message(command.answer, "user"),
          ),
        );
      }
    }
  }

  /** chat 模式的确定性路由：@群主=规划轮，@成员=隐式单成员任务，无 @=静默。 */
  private mentionRoute(text: string, group: CollaborationGroup): MentionRoute {
    const mentioned = parseMentions(text, group.members);
    if (mentioned.some((member) => member.id === group.ownerId))
      return { planning: true };
    const content = stripMentions(text, group.members).slice(0, 30000);
    const build = (member: (typeof mentioned)[number]): CollaborationTask => ({
      id: this.id(),
      memberId: member.id,
      title: content.slice(0, 80) || `处理 @${member.name}`,
      instructions: content || `处理 @${member.name}`,
      dependsOn: [],
      isolated: false,
      status: "queued",
      implicit: true,
    });
    return { tasks: mentioned.map(build) };
  }
  private wake(): void {
    void this.tick().catch(this.reportError);
  }

  /** The host calls tick even without viewers. Persisted leases prevent two hosts dispatching twice. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [holder, workspace] of this.workspaces)
        if (
          !this.repository.claimWorkspace(
            workspace.cwd,
            holder,
            Date.now(),
            15000,
            workspace.readOnly,
          )
        )
          this.active
            .get(holder.split("/")[0])
            ?.jobs.get(holder.split("/")[1])
            ?.abort();
      for (const summary of this.repository.listDiscussions()) {
        if (!["running", "stopping"].includes(summary.status)) continue;
        if (!this.repository.claim(summary.id, this.owner, Date.now(), 15000)) {
          for (const controller of this.active.get(summary.id)?.jobs.values() ||
            [])
            controller.abort();
          continue;
        }
        let state = this.discussion(summary.id);
        let local = this.active.get(state.id);
        if (!local) {
          local = { generation: state.generation, jobs: new Map() };
          this.active.set(state.id, local);
          if (
            state.planning ||
            state.tasks.some((t) => t.status === "running")
          ) {
            const sessions = [
              state.planningSessionId,
              ...state.tasks
                .filter((t) => t.status === "running")
                .map((t) => t.sessionId),
            ].filter((id): id is string => !!id);
            await Promise.allSettled(
              sessions.map((id) => this.runtime.abort(id)),
            );
            this.change(state.id, (domain) => {
              domain.interrupt();
              domain.append(
                this.message(
                  "服务恢复后发现未确认结果的执行，已停止继续派发。请核对记录后点击继续，群主会重新安排。",
                  "system",
                ),
              );
            });
            continue;
          }
        }
        if (state.status === "stopping") {
          for (const controller of local.jobs.values()) controller.abort();
          if (!local.jobs.size)
            this.change(state.id, (domain) => domain.finishStopping());
          continue;
        }
        const group = this.discussionGroup(state);
        if (
          state.ownerPending &&
          !state.planning &&
          !state.tasks.some(
            (t) => t.memberId === group.ownerId && t.status === "running",
          ) &&
          local.jobs.size < group.maxParallel
        ) {
          this.launch(state.id, "owner", () => this.plan(state.id));
          state = this.discussion(state.id);
        }
        for (const task of new CollaborationDiscussion(
          state,
          group,
        ).readyTasks()) {
          if (
            (this.workspaceRetryAfter.get(`${state.id}/${task.id}`) || 0) <=
            Date.now()
          )
            this.launch(state.id, task.id, () => this.work(state.id, task.id));
        }
      }
      for (const [id, local] of this.active) {
        const state = this.discussion(id);
        if (
          !local.jobs.size &&
          !["running", "stopping"].includes(state.status)
        ) {
          this.active.delete(id);
          this.repository.release(id, this.owner);
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private launch(id: string, key: string, run: () => Promise<void>): void {
    const local = this.active.get(id)!;
    if (local.jobs.has(key)) return;
    const controller = new AbortController();
    local.jobs.set(key, controller);
    void run()
      .catch((error) => {
        this.change(id, (domain) =>
          domain.pause(
            this.message(
              `协作暂停：${String(error instanceof Error ? error.message : error)}`,
              "system",
            ),
          ),
        );
      })
      .finally(() => {
        local.jobs.delete(key);
        this.wake();
      })
      .catch(this.reportError);
  }
  private async session(
    id: string,
    memberId: string,
    cwd: string,
    purpose: "planning" | "task" = "task",
  ): Promise<string> {
    const state = this.discussion(id),
      group = this.discussionGroup(state),
      key =
        purpose === "planning"
          ? `planning:${memberId}:${cwd}`
          : `${memberId}:${cwd}`;
    if (state.sessions[key]) return state.sessions[key];
    const sessionId = await this.runtime.createSession(
      group,
      group.members.find((m) => m.id === memberId)!,
      cwd,
    );
    this.change(id, (domain) => domain.rememberSession(key, sessionId));
    return sessionId;
  }
  private progress(
    id: string,
    generation: number,
    memberId: string,
    taskId?: string,
  ): (event: CollaborationProgress) => void {
    return (event) => {
      const current = this.discussion(id);
      if (
        current.generation !== generation ||
        !["running", "waiting"].includes(current.status)
      )
        return;
      this.change(id, (domain) => {
        if (event.resolvedQuestionId) {
          domain.resolveQuestion(event.resolvedQuestionId);
        } else
          domain.append({
            ...this.message(
              event.text,
              event.question ? "question" : "progress",
              memberId,
              taskId,
            ),
            ...(event.question ? { question: event.question } : {}),
          });
      });
    };
  }
  private async plan(id: string): Promise<void> {
    const group = this.discussionGroup(this.discussion(id)),
      owner = group.members.find((m) => m.id === group.ownerId)!;
    const start = this.change(id, (domain) => domain.beginPlanning());
    const signal = this.active.get(id)!.jobs.get("owner")!.signal;
    try {
      const sessionId = await this.session(id, owner.id, group.cwd, "planning");
      if (signal.aborted) return;
      this.change(id, (domain) => domain.planningSession(sessionId));
      const result = await this.runtime.execute(
        {
          group,
          member: owner,
          sessionId,
          prompt: collaborationOwnerPrompt(group, this.discussion(id)),
          signal,
        },
        this.progress(id, start.generation, owner.id),
      );
      const usage = result.usage;
      if (usage)
        this.change(id, (domain) => {
          if (domain.state.generation === start.generation)
            domain.recordUsage(usage);
        });
      this.change(id, (domain) => {
        if (
          domain.state.generation !== start.generation ||
          domain.state.status !== "running" ||
          domain.state.ownerPending
        )
          return;
        try {
          domain.applyDecision(
            parseCollaborationDecision(result.text),
            (content, kind) =>
              domain.append(this.message(content, kind, owner.id)),
          );
        } catch (error) {
          domain.rejectDecision(
            this.message(
              `协调决策需要修正：${error instanceof Error ? error.message : String(error)}`,
              "system",
            ),
          );
        }
      });
    } catch (error) {
      this.change(id, (domain) => {
        if (domain.state.generation === start.generation)
          domain.pause(
            this.message(
              `群主执行失败：${error instanceof Error ? error.message : String(error)}`,
              "system",
            ),
          );
      });
    } finally {
      this.change(id, (domain) => domain.finishPlanning());
    }
  }
  private async work(id: string, taskId: string): Promise<void> {
    const start = this.change(id, (domain) => domain.startTask(taskId));
    const group = this.discussionGroup(start),
      task = start.tasks.find((t) => t.id === taskId)!,
      member = group.members.find((m) => m.id === task.memberId)!;
    const signal = this.active.get(id)!.jobs.get(taskId)!.signal;
    const holder = `${id}/${taskId}`;
    let lockedCwd: string | undefined;
    try {
      const workspace = task.isolated
        ? await this.runtime.prepareWorkspace(group, id, taskId)
        : { cwd: group.cwd, isolated: false };
      if (signal.aborted || this.discussion(id).generation !== start.generation)
        return;
      if (task.isolated && !workspace.isolated) {
        this.change(id, (domain) => {
          domain.deferTask(taskId, false);
          domain.append(
            this.message(
              workspace.note || "无法隔离，任务将在共享目录排队执行。",
              "system",
              member.id,
              taskId,
            ),
          );
        });
        return;
      }
      if (
        !this.repository.claimWorkspace(
          workspace.cwd,
          holder,
          Date.now(),
          15000,
          !!task.readOnly,
        )
      ) {
        this.workspaceRetryAfter.set(holder, Date.now() + 1000);
        this.change(id, (domain) =>
          domain.deferTask(taskId, task.isolated, "等待工作目录空闲"),
        );
        return;
      }
      this.workspaceRetryAfter.delete(holder);
      lockedCwd = workspace.cwd;
      this.workspaces.set(holder, {
        cwd: workspace.cwd,
        readOnly: !!task.readOnly,
      });
      const sessionId = await this.session(id, member.id, workspace.cwd);
      if (signal.aborted || this.discussion(id).generation !== start.generation)
        return;
      this.change(id, (domain) =>
        domain.attachTaskSession(
          taskId,
          sessionId,
          workspace.cwd,
          this.message(`开始：${task.title}`, "progress", member.id, taskId),
        ),
      );
      const current = this.discussion(id),
        currentTask = current.tasks.find((t) => t.id === taskId)!;
      const result = await this.runtime.execute(
        {
          group,
          member,
          sessionId,
          prompt: collaborationWorkerPrompt(group, current, currentTask),
          signal,
        },
        this.progress(id, start.generation, member.id, taskId),
      );
      let text = result.text;
      let success = true;
      if (task.verification) {
        const check = await this.runtime.verify(
          workspace.cwd,
          task.verification.command,
          signal,
        );
        if (!check.ok) {
          text = `验收命令失败：${task.verification.command}\n${check.output.slice(-4000)}`;
          success = false;
        }
      }
      const usage = result.usage;
      this.change(id, (domain) => {
        if (domain.state.generation !== start.generation) return;
        if (usage) domain.recordUsage(usage);
        if (domain.settleTask(taskId, text, success))
          domain.append(this.message(text, "member", member.id, taskId));
      });
    } catch (error) {
      const text = `步骤失败：${error instanceof Error ? error.message : String(error)}`;
      this.change(id, (domain) => {
        if (
          domain.state.generation === start.generation &&
          domain.settleTask(taskId, text, false)
        )
          domain.append(this.message(text, "member", member.id, taskId));
      });
    } finally {
      if (lockedCwd) {
        this.workspaces.delete(holder);
        this.repository.releaseWorkspace(lockedCwd, holder);
      }
    }
  }
}
