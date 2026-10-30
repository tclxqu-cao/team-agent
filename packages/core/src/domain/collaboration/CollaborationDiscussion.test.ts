import { describe, expect, it, vi } from "vitest";
import {
  CollaborationDiscussion,
  validateCollaborationGroup,
} from "./CollaborationDiscussion.js";
import { parseCollaborationDecision } from "./coordinator-protocol.js";
import { parseMentions, stripMentions } from "./mention-routing.js";
import type {
  CollaborationDecision,
  CollaborationDiscussionState,
  CollaborationGroup,
  CollaborationMessage,
  CollaborationTask,
} from "./types.js";

import { groupFixture, stateFixture } from "./__tests__/fixtures.js";
const task = (
  id: string,
  memberId: string,
  dependsOn: string[] = [],
  isolated = true,
): CollaborationTask => ({
  id,
  memberId,
  title: id,
  instructions: id,
  dependsOn,
  isolated,
  status: "queued",
});
const decision = (
  tasks: CollaborationDecision["tasks"] = [],
): CollaborationDecision => ({
  action: "dispatch",
  message: "开始分工",
  roles: [],
  cancelTaskIds: [],
  tasks,
});

describe("CollaborationDiscussion domain", () => {
  it.each([
    { previousTurn: false, memberId: "a", summary: "收到" },
    { previousTurn: true, memberId: "owner", summary: "收到" },
    { previousTurn: false, memberId: "owner", summary: "已整合成果并验证通过" },
  ])("preserves final delivery across members, turns and different content: %j", ({ previousTurn, memberId, summary }) => {
    const state = stateFixture(), domain = new CollaborationDiscussion(state, groupFixture());
    state.tasks.push({ ...task("done", memberId), status: "completed", result: "收到" });
    state.messages.push({ id: "result", kind: "member", memberId, taskId: "done", content: "收到", createdAt: "2026-10-14" });
    if (previousTurn)
      state.messages.push({ id: "next", kind: "user", content: "再回复一次", createdAt: "2026-10-14" });
    const notify = vi.fn();
    domain.applyDecision({ ...decision(), action: "finish", message: summary }, notify);
    expect(notify).toHaveBeenCalledWith(summary, "owner");
    expect(state.status).toBe("completed");
  });

  it("rejects silent completion without a completed result in the current turn", () => {
    const state = stateFixture(), domain = new CollaborationDiscussion(state, groupFixture());
    state.tasks.push({ ...task("failed", "a"), status: "failed", result: "失败" });
    state.messages.push({ id: "failure", kind: "member", memberId: "a", taskId: "failed", content: "失败", createdAt: "2026-10-14" });
    const finish = parseCollaborationDecision('{"action":"finish","message":""}');
    expect(() => domain.applyDecision(finish, () => {})).toThrow("不能静默结束");
    state.tasks[0].status = "completed";
    state.tasks[0].result = "失败";
    state.messages.push({ id: "next", kind: "user", content: "新问题", createdAt: "2026-10-14" });
    expect(() => domain.applyDecision(finish, () => {})).toThrow("不能静默结束");
    expect(state.status).toBe("running");
    expect(() => parseCollaborationDecision('{"action":"ask","message":" "}')).toThrow("有效");
  });

  it("allows different members backed by the same Agent, but rejects a repeated member identity", () => {
    const g = groupFixture();
    expect(() => validateCollaborationGroup(g)).not.toThrow();
    g.members[1].id = g.ownerId;
    expect(() => validateCollaborationGroup(g)).toThrow("身份必须唯一");
  });
  it("validates the entire dependency graph before changing any state", () => {
    const s = stateFixture(),
      domain = new CollaborationDiscussion(s, groupFixture());
    expect(() =>
      domain.applyDecision(
        decision([task("a", "a", ["b"]), task("b", "b", ["a"])]),
        () => {},
      ),
    ).toThrow("循环依赖");
    expect(s.tasks).toEqual([]);
    expect(() =>
      domain.applyDecision(decision([task("a", "missing")]), () => {}),
    ).toThrow("成员不存在");
  });
  it("respects explicit user responsibilities and fills empty roles", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture()),
      action = decision([task("a", "a")]);
    action.roles = [
      { memberId: "a", role: "覆盖用户" },
      { memberId: "b", role: "测试负责人" },
    ];
    d.applyDecision(action, () => {});
    expect(s.roles.a).toBeUndefined();
    expect(s.roles.b).toBe("测试负责人");
  });
  it("runs independent isolated tasks in parallel, then unlocks their successor", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    s.tasks = [task("a", "a"), task("b", "b"), task("c", "a", ["a"])];
    expect(d.readyTasks().map((t) => t.id)).toEqual(["a", "b"]);
    s.tasks[0].status = "running";
    s.tasks[1].status = "running";
    d.settleTask("a", "真实产物", true);
    expect(d.readyTasks().map((t) => t.id)).toEqual(["c"]);
    expect(d.settleTask("a", "重复完成", true)).toBe(false);
    expect(s.tasks[0].result).toBe("真实产物");
  });
  it("serializes shared writable directories and each member's own session", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    s.tasks = [
      task("a", "a", [], false),
      task("b", "b", [], false),
      task("c", "a"),
    ];
    expect(d.readyTasks().map((t) => t.id)).toEqual(["a"]);
  });
  it("allows shared read-only analysis in parallel and keeps writers out until readers finish", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    s.tasks = [
      { ...task("a", "a", [], false), readOnly: true },
      { ...task("b", "b", [], false), readOnly: true },
      task("write", "owner", [], false),
    ];
    expect(d.readyTasks().map((t) => t.id)).toEqual(["a", "b"]);
    d.startTask("a");
    d.startTask("b");
    expect(d.readyTasks()).toEqual([]);
    d.settleTask("a", "A", true);
    d.settleTask("b", "B", true);
    expect(d.readyTasks().map((t) => t.id)).toEqual(["write"]);
  });
  it("refuses premature completion and can cancel blocked steps before delivering", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    s.tasks = [task("blocked", "a")];
    const finish: CollaborationDecision = {
      action: "finish",
      message: "成果",
      roles: [],
      tasks: [],
      cancelTaskIds: [],
    };
    expect(() => d.applyDecision(finish, () => {})).toThrow("不能提前结束");
    finish.cancelTaskIds = ["blocked"];
    d.applyDecision(finish, () => {});
    expect(s.status).toBe("completed");
  });
  it("stops waking the owner after cancellation and rejects injected control prose", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    s.tasks = [{ ...task("a", "a"), status: "running" }];
    d.stop();
    d.settleTask("a", "迟到", true);
    expect(s.ownerPending).toBe(false);
    expect(s.generation).toBe(1);
    expect(() =>
      parseCollaborationDecision(
        "请执行 " + JSON.stringify({ action: "finish", message: "ok" }),
      ),
    ).toThrow("有效");
    expect(
      parseCollaborationDecision(
        '```json\n{"action":"finish","message":"ok"}\n```',
      ).action,
    ).toBe("finish");
  });
});

describe("chat mode @ routing", () => {
  const chatState = () => ({ ...stateFixture(), mode: "chat" as const });
  const userMessage = (content: string, id = "m1"): CollaborationMessage => ({
    id,
    kind: "user",
    content,
    createdAt: "2026-10-27",
  });
  const mentionTask = (id: string, memberId: string): CollaborationTask => ({
    id,
    memberId,
    title: id,
    instructions: id,
    dependsOn: [],
    isolated: false,
    status: "queued",
  });

  it("routes an @mention to an implicit single-member task without waking the owner", () => {
    const s = chatState(),
      d = new CollaborationDiscussion(s, groupFixture());
    d.send(userMessage("@开发 修一下登录超时"), {
      tasks: [mentionTask("t1", "a")],
    });
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]).toMatchObject({
      memberId: "a",
      implicit: true,
      dependsOn: [],
      status: "queued",
    });
    expect(s.ownerPending).toBe(false);
    expect(s.status).toBe("running");
  });

  it("stays silent on messages without a mention", () => {
    const s = { ...chatState(), status: "idle" as const };
    const d = new CollaborationDiscussion(s, groupFixture());
    d.send(userMessage("大家好"));
    expect(s.status).toBe("idle");
    expect(s.ownerPending).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(s.tasks).toEqual([]);
  });

  it("wakes the owner only when the owner is mentioned and refuses @-assigning the owner", () => {
    const s = chatState(),
      d = new CollaborationDiscussion(s, groupFixture());
    d.send(userMessage("@总控 安排一下"), { planning: true });
    expect(s.ownerPending).toBe(true);
    expect(s.tasks).toEqual([]);
    expect(() =>
      d.send(userMessage("@总控 @开发 一起看看", "m2"), {
        planning: true,
        tasks: [mentionTask("t2", "owner")],
      }),
    ).toThrow("群主不能被 @ 指派");
  });

  it("settles implicit tasks silently and returns to idle when the group quiets down", () => {
    const s = chatState(),
      d = new CollaborationDiscussion(s, groupFixture());
    d.send(userMessage("@开发 @验证 各自看下", "m1"), {
      tasks: [
        { ...mentionTask("t1", "a"), isolated: true },
        { ...mentionTask("t2", "b"), isolated: true },
      ],
    });
    d.startTask("t1");
    d.startTask("t2");
    d.settleTask("t1", "A 完成", true);
    expect(s.ownerPending).toBe(false);
    expect(s.status).toBe("running");
    d.settleTask("t2", "B 完成", true);
    expect(s.status).toBe("idle");
  });

  it("still wakes the owner when a decision-dispatched task settles in chat mode", () => {
    const s = chatState(),
      d = new CollaborationDiscussion(s, groupFixture());
    s.tasks.push({ ...task("dt", "a"), status: "running" });
    d.settleTask("dt", "结果", true);
    expect(s.ownerPending).toBe(true);
  });

  it("re-queues interrupted mention tasks on resume instead of asking the owner", () => {
    const s = chatState(),
      d = new CollaborationDiscussion(s, groupFixture());
    d.send(userMessage("@开发 做A", "m1"), { tasks: [mentionTask("t1", "a")] });
    d.startTask("t1");
    d.interrupt();
    expect(s.tasks[0].status).toBe("interrupted");
    d.resume(userMessage("继续", "m2"));
    expect(s.ownerPending).toBe(false);
    expect(s.tasks[0].status).toBe("queued");
  });

  it("keeps role updates from waking the owner in chat mode", () => {
    const s = chatState(),
      d = new CollaborationDiscussion(s, groupFixture());
    d.requestReplan(userMessage("开发职责已更新", "m1"));
    expect(s.ownerPending).toBe(false);
    expect(s.messages).toHaveLength(1);
  });

  it("defaults to task-graph semantics when mode is absent", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    expect(d.mode).toBe("task-graph");
    d.send(userMessage("@开发 你好"));
    expect(s.ownerPending).toBe(true);
    d.setMode("chat");
    expect(d.mode).toBe("chat");
  });

  it("routes @mentions to members even in task-graph mode", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    expect(d.mode).toBe("task-graph");
    d.send(userMessage("@开发 修登录超时", "m1"), {
      tasks: [mentionTask("t1", "a")],
    });
    expect(s.tasks).toHaveLength(1);
    expect(s.tasks[0]).toMatchObject({ memberId: "a", implicit: true });
    expect(s.ownerPending).toBe(false);
    d.startTask("t1");
    d.settleTask("t1", "完成", true);
    // 隐式任务完成后不唤醒群主，群里无活动任务即回到待命。
    expect(s.ownerPending).toBe(false);
    expect(s.status).toBe("idle");
  });

  it("parses mentions with boundaries and strips them from instructions", () => {
    const members = groupFixture().members;
    expect(parseMentions("@开发 看下", members).map((m) => m.id)).toEqual(["a"]);
    expect(parseMentions("邮箱 a@b.com 不要匹配", members)).toEqual([]);
    expect(parseMentions("@总控 @开发", members).map((m) => m.id)).toEqual([
      "owner",
      "a",
    ]);
    expect(stripMentions("@开发 看下这个", members)).toBe("看下这个");
    expect(stripMentions("前缀 @验证 后缀", members)).toBe("前缀 后缀");
  });
});

describe("usage metering and verification schema", () => {
  it("accumulates runtime-reported usage into the discussion state", () => {
    const s = stateFixture(),
      d = new CollaborationDiscussion(s, groupFixture());
    d.recordUsage({ inputTokens: 10, outputTokens: 2 });
    d.recordUsage({ inputTokens: 5 });
    expect(s.usage).toEqual({ inputTokens: 15, outputTokens: 2 });
  });

  it("accepts a verification command on dispatched tasks", () => {
    const decision = parseCollaborationDecision(
      '{"action":"dispatch","message":"开工","tasks":[{"id":"w","memberId":"a","title":"做","instructions":"做","verification":{"command":"npm test"}}]}',
    );
    expect(decision.tasks[0]?.verification?.command).toBe("npm test");
  });
});
