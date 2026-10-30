import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollaborationService } from "./CollaborationService.js";
import { SQLiteCollaborationRepository } from "../../infrastructure/SQLiteCollaborationRepository.js";
import { getDatabase } from "../../infrastructure/SQLiteDatabase.js";
import { groupFixture } from "../../domain/collaboration/__tests__/fixtures.js";
import type { CollaborationRuntime } from "./ports.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    getDatabase(dir).close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function setup(runtime: CollaborationRuntime) {
  const dir = mkdtempSync(join(tmpdir(), "collaboration-usecase-"));
  dirs.push(dir);
  const repo = new SQLiteCollaborationRepository(dir);
  const service = new CollaborationService(repo, runtime);
  repo.saveGroup(groupFixture());
  const discussion = service.createDiscussion("g");
  return { repo, service, id: discussion.id };
}
const runtimeBase = (): CollaborationRuntime => ({
  prepareWorkspace: async (group, _d, t) => ({
    cwd: `${group.cwd}/${t}`,
    isolated: true,
  }),
  createSession: async (_g, m, cwd) => `${m.id}:${cwd}`,
  execute: async () => ({ text: "" }),
  verify: async () => ({ ok: true, output: "" }),
  abort: async () => {},
  answer: async () => true,
});

describe("CollaborationService orchestration", () => {
  it("answers a planner decision once and rejects a stale Dashboard decision revision", async () => {
    const runtime = runtimeBase(); runtime.execute = async () => ({ text: JSON.stringify({ action: "finish", message: "决定已落实" }) });
    const { service, repo, id } = setup(runtime);
    repo.updateDiscussion(id, state => { state.status = "waiting"; state.messages.push({ id: "decision", kind: "owner", content: "请选择交付方案", createdAt: "2026-10-28" }); });
    const revision = service.discussion(id).revision;
    const command = { action: "answerDecision" as const, discussionId: id, expectedRevision: revision, answer: "选择方案 A", messageId: "decision-answer" };
    await service.command(command);
    await vi.waitFor(() => expect(service.discussion(id).status).toBe("completed"));
    await service.command(command);
    expect(service.discussion(id).messages.filter(message => message.id === command.messageId)).toHaveLength(1);
    await expect(service.command({ ...command, messageId: "stale-answer" })).rejects.toThrow("已处理");
  });
  it.each(["收到", ""])(
    "publishes each member's reply once when the owner finishes with %j",
    async (finalMessage) => {
      const runtime = runtimeBase();
      runtime.prepareWorkspace = async (group) => ({ cwd: group.cwd, isolated: false });
      const { service, repo, id } = setup(runtime);
      const executed: string[] = [];
      runtime.execute = async (input) => {
        const state = service.discussion(id);
        const round = state.messages.filter((message) => message.kind === "user").length;
        if (input.member.id === "owner" && state.planning) {
          const tasks = state.tasks.filter((task) => task.id.endsWith(`_${round}`));
          return {
            text: JSON.stringify(
              !tasks.length
                ? {
                    action: "dispatch",
                    message: "收到",
                    tasks: ["owner", "a"].map((memberId) => ({
                      id: `${memberId}_${round}`,
                      memberId,
                      title: "仅回复收到",
                      instructions: "仅回复收到，不附加报告",
                      readOnly: true,
                    })),
                  }
                : tasks.some((task) => task.status !== "completed")
                  ? { action: "wait", message: "收到" }
                  : { action: "finish", message: finalMessage },
            ),
          };
        }
        const task = state.tasks.find(
          (task) => task.memberId === input.member.id && task.status === "running",
        )!;
        executed.push(task.id);
        return { text: "收到" };
      };

      for (const round of [1, 2]) {
        await service.command({
          action: "send", discussionId: id,
          text: "你们都只回复收到，其他不要回复", messageId: `input_${round}`,
        });
        await vi.waitFor(() => expect(service.discussion(id).status).toBe("completed"));
      }

      const state = repo.getDiscussion(id)!;
      expect(executed.sort()).toEqual(["a_1", "a_2", "owner_1", "owner_2"]);
      expect(state.messages.filter((message) => message.kind !== "progress").map(
        ({ kind, memberId, content }) => ({ kind, memberId, content }),
      )).toEqual([1, 2].flatMap(() => [
        { kind: "user", memberId: undefined, content: "你们都只回复收到，其他不要回复" },
        { kind: "member", memberId: "owner", content: "收到" },
        { kind: "member", memberId: "a", content: "收到" },
      ]));
      expect(state.tasks.every((task) => task.status === "completed")).toBe(true);
      expect(state.messages.some((message) => message.kind === "progress" && message.content.startsWith("开始："))).toBe(true);
    },
  );

  it("persists group edits while old discussions continue with their original execution configuration", async () => {
    const runtime = runtimeBase();
    const executions: string[] = [];
    runtime.execute = async input => {
      executions.push(input.group.cwd);
      return { text: JSON.stringify({ action: "finish", message: "完成" }) };
    };
    const { repo, service, id } = setup(runtime);
    repo.updateDiscussion(id, state => {
      state.groupSnapshot = undefined; // Upgrade coverage for existing groups.
      state.messages.push({ id: "old", kind: "user", content: "旧记录", createdAt: "2026-10-14" });
    });
    const original = service.group("g");
    await service.command({ action: "updateGroup", groupId: "g", group: { ...original, name: "新群名", cwd: "/new-project", maxParallel: 2, members: original.members.slice(0, 2) } });
    expect(service.group("g").name).toBe("新群名");
    expect(service.discussion(id).messages[0].content).toBe("旧记录");
    expect(service.discussion(id).groupSnapshot?.members).toHaveLength(3);
    const fresh = service.createDiscussion("g");
    expect(fresh.groupSnapshot?.members).toHaveLength(2);
    await service.command({ action: "send", discussionId: id, text: "继续", messageId: "next" });
    await vi.waitFor(() => expect(service.discussion(id).status).toBe("completed"));
    expect(executions).toEqual(["/project"]);
  });

  it("removes deleted groups from discovery and blocks direct history/resume without exposing internal sessions", async () => {
    const { repo, service, id } = setup(runtimeBase());
    repo.updateDiscussion(id, state => { state.sessions["owner:/project"] = "internal-session"; });
    await service.command({ action: "deleteGroup", groupId: "g" });
    expect(await service.command({ action: "groups" })).toEqual([]);
    expect(repo.listDiscussions()).toEqual([]);
    expect(repo.memberSessionIds().has("internal-session")).toBe(true);
    expect(repo.getDiscussion(id)).not.toBeNull();
    await expect(service.command({ action: "discussion", discussionId: id })).rejects.toThrow("已删除");
    await expect(service.command({ action: "resume", discussionId: id })).rejects.toThrow("已删除");
  });

  it("rejects a busy delete transaction without losing the group or discussion", async () => {
    const { repo, service, id } = setup(runtimeBase());
    repo.updateDiscussion(id, state => { state.status = "running"; });
    await expect(service.command({ action: "deleteGroup", groupId: "g" })).rejects.toThrow("请先停止");
    expect(service.group("g").deletedAt).toBeUndefined();
    expect(repo.listDiscussions("g")).toHaveLength(1);
  });

  it("executes two real port calls in parallel, wakes the owner and runs a dependent step before final delivery", async () => {
    const runtime = runtimeBase();
    const finishes = new Map<string, () => void>();
    const started: string[] = [];
    let maxWorkers = 0,
      workers = 0;
    const { repo, service, id } = setup(runtime);
    runtime.execute = async (input, progress) => {
      if (input.member.id === "owner") {
        const state = repo.getDiscussion(id)!;
        return {
          text: JSON.stringify(
            state.tasks.length === 0
              ? {
                  action: "dispatch",
                  message: "并行开始",
                  roles: [{ memberId: "b", role: "验证" }],
                  tasks: [
                    {
                      id: "a",
                      memberId: "a",
                      title: "实现",
                      instructions: "做A",
                      dependsOn: [],
                      isolated: true,
                    },
                    {
                      id: "b",
                      memberId: "b",
                      title: "分析",
                      instructions: "做B",
                      dependsOn: [],
                      isolated: true,
                    },
                    {
                      id: "c",
                      memberId: "a",
                      title: "验证实现",
                      instructions: "做C",
                      dependsOn: ["a"],
                      isolated: true,
                    },
                  ],
                }
              : state.tasks.some((t) =>
                    ["queued", "running"].includes(t.status),
                  )
                ? { action: "wait", message: "收到进展，继续协作" }
                : { action: "finish", message: "最终成果已汇总" },
          ),
        };
      }
      const task = repo
        .getDiscussion(id)!
        .tasks.find(
          (t) => t.sessionId === input.sessionId && t.status === "running",
        )!;
      started.push(task.id);
      workers++;
      maxWorkers = Math.max(maxWorkers, workers);
      progress({ text: "真实进度" });
      if (task.id !== "c")
        await new Promise<void>((resolve, reject) => {
          finishes.set(task.id, resolve);
          input.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        });
      workers--;
      return { text: `${task.id} 的实际成果` };
    };
    await service.command({
      action: "send",
      discussionId: id,
      text: "完成一个任务",
      messageId: "input",
    });
    await vi.waitFor(() => expect(started).toEqual(["a", "b"]));
    expect(maxWorkers).toBe(2);
    finishes.get("a")!();
    await vi.waitFor(() => expect(started).toContain("c"));
    finishes.get("b")!();
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.status).toBe("completed"),
    );
    expect(repo.getDiscussion(id)?.messages.at(-1)?.content).toBe(
      "最终成果已汇总",
    );
    expect(repo.getDiscussion(id)?.roles.b).toBe("验证");
    expect(
      repo.getDiscussion(id)?.messages.some((m) => m.kind === "progress"),
    ).toBe(true);
    const calls = started.length;
    await service.command({ action: "discussion", discussionId: id });
    await service.command({ action: "discussions", groupId: "g" });
    expect(started).toHaveLength(calls);
  });
  it("does not replay duplicate messages or trust an invalid owner decision after two attempts", async () => {
    const runtime = runtimeBase();
    runtime.execute = vi.fn(async () => ({
      text: "ordinary prose is not a dispatch",
    }));
    const { service, repo, id } = setup(runtime);
    await service.command({
      action: "send",
      discussionId: id,
      text: "消息",
      messageId: "same",
    });
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.status).toBe("waiting"),
    );
    await service.command({
      action: "send",
      discussionId: id,
      text: "消息",
      messageId: "same",
    });
    expect(
      repo.getDiscussion(id)?.messages.filter((m) => m.kind === "user"),
    ).toHaveLength(1);
    expect(runtime.execute).toHaveBeenCalledTimes(2);
  });
  it("cancels an active member and prevents its late output from restarting the owner", async () => {
    const runtime = runtimeBase();
    let workerStarted = false;
    runtime.execute = vi.fn(async (input) => {
      if (input.member.id === "owner")
        return {
          text: JSON.stringify({
            action: "dispatch",
            message: "开始",
            tasks: [
              {
                id: "a",
                memberId: "a",
                title: "步骤",
                instructions: "执行",
                isolated: false,
              },
            ],
          }),
        };
      workerStarted = true;
      return await new Promise<{ text: string }>((resolve) =>
        input.signal.addEventListener(
          "abort",
          () => resolve({ text: "迟到的结果" }),
          { once: true },
        ),
      );
    });
    const { service, repo, id } = setup(runtime);
    await service.command({
      action: "send",
      discussionId: id,
      text: "做事",
      messageId: "m",
    });
    await vi.waitFor(() => expect(workerStarted).toBe(true));
    await service.command({ action: "stop", discussionId: id });
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.status).toBe("stopped"),
    );
    expect(
      repo.getDiscussion(id)?.messages.some((m) => m.content === "迟到的结果"),
    ).toBe(false);
    expect(runtime.execute).toHaveBeenCalledTimes(2);
  });
  it("recovers unknown in-flight work as interrupted instead of executing it twice", async () => {
    const runtime = runtimeBase();
    runtime.abort = vi.fn(async () => {});
    runtime.execute = vi.fn();
    const { service, repo, id } = setup(runtime);
    repo.updateDiscussion(id, (s) => {
      s.status = "running";
      s.planning = true;
      s.planningSessionId = "existing";
    });
    await service.tick();
    expect(repo.getDiscussion(id)?.status).toBe("interrupted");
    expect(runtime.abort).toHaveBeenCalledWith("existing");
    expect(runtime.execute).not.toHaveBeenCalled();
  });

  it("reports a member failure to the owner and lets it cancel blocked successors", async () => {
    const runtime = runtimeBase();
    const { service, repo, id } = setup(runtime);
    runtime.execute = async (input) => {
      if (input.member.id !== "owner") throw new Error("成员运行时不可用");
      const failed = repo
        .getDiscussion(id)!
        .tasks.some((task) => task.status === "failed");
      return {
        text: JSON.stringify(
          failed
            ? {
                action: "finish",
                message: "运行失败，已取消依赖任务，没有声称产物完成。",
                cancelTaskIds: ["blocked"],
              }
            : {
                action: "dispatch",
                message: "开始",
                tasks: [
                  {
                    id: "work",
                    memberId: "a",
                    title: "实现",
                    instructions: "执行",
                  },
                  {
                    id: "blocked",
                    memberId: "b",
                    title: "验收",
                    instructions: "检查",
                    dependsOn: ["work"],
                  },
                ],
              },
        ),
      };
    };
    await service.command({
      action: "send",
      discussionId: id,
      text: "开始任务",
      messageId: "failure-case",
    });
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.status).toBe("completed"),
    );
    expect(repo.getDiscussion(id)?.tasks.map((task) => task.status)).toEqual([
      "failed",
      "cancelled",
    ]);
    expect(
      repo
        .getDiscussion(id)
        ?.messages.some((message) =>
          message.content.includes("成员运行时不可用"),
        ),
    ).toBe(true);
  });
});

describe("chat mode mention routing", () => {
  it("routes @mentions to members in the default task-graph discussion too", async () => {
    const runtime = runtimeBase();
    const executed: string[] = [];
    let ownerRounds = 0;
    runtime.prepareWorkspace = async (group) => ({
      cwd: group.cwd,
      isolated: false,
    });
    runtime.execute = async (input) => {
      if (input.member.id === "owner") {
        ownerRounds += 1;
        return { text: JSON.stringify({ action: "finish", message: "完成" }) };
      }
      executed.push(input.member.id);
      return { text: "已处理" };
    };
    const { service } = setup(runtime);
    const id = service.createDiscussion("g").id; // 默认 task-graph
    expect(service.discussion(id).mode ?? "task-graph").toBe("task-graph");
    await service.command({
      action: "send",
      discussionId: id,
      text: "@开发 修一下登录超时",
      messageId: "m1",
    });
    await vi.waitFor(() => expect(service.discussion(id).status).toBe("idle"));
    expect(executed).toEqual(["a"]);
    expect(ownerRounds).toBe(0);
  });

  it("routes @mentions straight to members without an owner planning round", async () => {
    const runtime = runtimeBase();
    const executed: string[] = [];
    let ownerRounds = 0;
    runtime.execute = async (input) => {
      if (input.member.id === "owner") {
        ownerRounds += 1;
        return { text: JSON.stringify({ action: "finish", message: "完成" }) };
      }
      executed.push(input.member.id);
      return { text: "已处理" };
    };
    const { service } = setup(runtime);
    const id = service.createDiscussion("g", "chat").id;
    await service.command({
      action: "send",
      discussionId: id,
      text: "@开发 修一下登录超时",
      messageId: "m1",
    });
    await vi.waitFor(() =>
      expect(service.discussion(id).status).toBe("idle"),
    );
    expect(executed).toEqual(["a"]);
    expect(ownerRounds).toBe(0);
    expect(service.discussion(id).tasks[0]).toMatchObject({
      memberId: "a",
      implicit: true,
      status: "completed",
    });
    await service.command({
      action: "send",
      discussionId: id,
      text: "谢谢",
      messageId: "m2",
    });
    expect(service.discussion(id).status).toBe("idle");
    expect(
      service.discussion(id).messages.some((message) => message.content === "谢谢"),
    ).toBe(true);
  });

  it("keeps owner planning sessions separate from owner task sessions", async () => {
    const runtime = runtimeBase();
    runtime.prepareWorkspace = async (group) => ({
      cwd: group.cwd,
      isolated: false,
    });
    const created: string[] = [];
    runtime.createSession = async (_group, member, cwd) => {
      created.push(member.id);
      return `${member.id}:${cwd}:${created.length}`;
    };
    const { repo, service, id } = setup(runtime);
    runtime.execute = async (input) => {
      const state = repo.getDiscussion(id)!;
      if (input.member.id === "owner" && state.planning) {
        return {
          text: JSON.stringify(
            state.tasks.length === 0
              ? {
                  action: "dispatch",
                  message: "自己来",
                  tasks: [
                    {
                      id: "own",
                      memberId: "owner",
                      title: "自查",
                      instructions: "自己完成并汇报",
                      isolated: false,
                      readOnly: true,
                    },
                  ],
                }
              : state.tasks.some((task) =>
                  ["queued", "running"].includes(task.status),
                )
                ? { action: "wait", message: "等待" }
                : { action: "finish", message: "完成" },
          ),
        };
      }
      return { text: "自做完成" };
    };
    await service.command({
      action: "send",
      discussionId: id,
      text: "安排自查",
      messageId: "m1",
    });
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.status).toBe("completed"),
    );
    expect(created.filter((member) => member === "owner")).toHaveLength(2);
    expect(Object.keys(repo.getDiscussion(id)!.sessions).sort()).toEqual([
      "owner:/project",
      "planning:owner:/project",
    ]);
  });
});

describe("task verification and usage metering", () => {
  it("runs the verification command and fails the task when it exits nonzero", async () => {
    const runtime = runtimeBase();
    runtime.prepareWorkspace = async (group) => ({
      cwd: group.cwd,
      isolated: false,
    });
    const verifications: Array<{ cwd: string; command: string }> = [];
    runtime.verify = async (cwd, command) => {
      verifications.push({ cwd, command });
      return { ok: false, output: "1 item mismatched" };
    };
    const { repo, service, id } = setup(runtime);
    runtime.execute = async (input) => {
      const state = repo.getDiscussion(id)!;
      if (input.member.id === "owner" && state.planning) {
        return {
          text: JSON.stringify(
            state.tasks.length === 0
              ? {
                  action: "dispatch",
                  message: "改完就验",
                  tasks: [
                    {
                      id: "work",
                      memberId: "a",
                      title: "实现",
                      instructions: "执行",
                      verification: { command: "npm test" },
                    },
                  ],
                }
              : state.tasks.some((task) =>
                  ["queued", "running"].includes(task.status),
                )
                ? { action: "wait", message: "等待" }
                : { action: "finish", message: "返工安排完毕" },
          ),
        };
      }
      return { text: "做完了" };
    };
    await service.command({
      action: "send",
      discussionId: id,
      text: "开始",
      messageId: "v1",
    });
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.tasks[0]?.status).toBe("failed"),
    );
    expect(verifications).toEqual([{ cwd: "/project", command: "npm test" }]);
    const failed = repo.getDiscussion(id)!.tasks[0]!;
    expect(failed.result).toContain("验收命令失败");
    expect(failed.result).toContain("1 item mismatched");
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.status).toBe("completed"),
    );
  });

  it("accumulates reported token usage across owner planning and worker execution", async () => {
    const runtime = runtimeBase();
    runtime.prepareWorkspace = async (group) => ({
      cwd: group.cwd,
      isolated: false,
    });
    const { repo, service, id } = setup(runtime);
    runtime.execute = async (input) => {
      const state = repo.getDiscussion(id)!;
      if (input.member.id === "owner" && state.planning) {
        return {
          usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
          text: JSON.stringify(
            state.tasks.length === 0
              ? {
                  action: "dispatch",
                  message: "开工",
                  tasks: [
                    {
                      id: "w",
                      memberId: "a",
                      title: "做",
                      instructions: "做",
                      isolated: false,
                      readOnly: true,
                    },
                  ],
                }
              : state.tasks.some((task) =>
                  ["queued", "running"].includes(task.status),
                )
                ? { action: "wait", message: "等" }
                : { action: "finish", message: "完成" },
          ),
        };
      }
      return {
        usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 },
        text: "做完",
      };
    };
    await service.command({
      action: "send",
      discussionId: id,
      text: "开始",
      messageId: "u1",
    });
    await vi.waitFor(() =>
      expect(repo.getDiscussion(id)?.status).toBe("completed"),
    );
    expect(repo.getDiscussion(id)!.usage).toEqual({
      inputTokens: 250,
      outputTokens: 25,
    });
  });
});
