import { describe, expect, it, vi } from "vitest";
import {
  CollaborationDiscussion,
  validateCollaborationGroup,
} from "./CollaborationDiscussion.js";
import { parseCollaborationDecision } from "./coordinator-protocol.js";
import type {
  CollaborationDecision,
  CollaborationDiscussionState,
  CollaborationGroup,
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
