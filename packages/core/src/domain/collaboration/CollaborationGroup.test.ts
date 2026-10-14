import { describe, expect, it } from "vitest";
import { CollaborationGroupAggregate } from "./CollaborationGroup.js";
import { groupFixture, stateFixture } from "./__tests__/fixtures.js";

describe("collaboration group lifecycle", () => {
  it("preserves legacy discussion configuration before editing members and workspace", () => {
    const group = groupFixture(),
      before = structuredClone(group);
    const discussion = { ...stateFixture(), status: "completed" as const };
    new CollaborationGroupAggregate(group).update(
      {
        ...group,
        name: "新团队",
        cwd: "/new",
        members: group.members.slice(0, 2),
        maxParallel: 2,
      },
      [discussion],
    );
    expect(group.name).toBe("新团队");
    expect(group.id).toBe(before.id);
    expect(group.createdAt).toBe(before.createdAt);
    expect(discussion.groupSnapshot).toEqual(before);
    group.members[0].role = "新职责";
    expect(discussion.groupSnapshot?.members[0].role).toBe("");
  });

  it.each(["running", "waiting", "stopping"] as const)(
    "rejects editing and deleting a %s group",
    (status) => {
      const group = groupFixture(),
        aggregate = new CollaborationGroupAggregate(group);
      const state = { ...stateFixture(), status };
      expect(() =>
        aggregate.update({ ...group, name: "不保存" }, [state]),
      ).toThrow("请先停止");
      expect(() => aggregate.delete([state], "now")).toThrow("请先停止");
      expect(group.name).toBe("协作群");
      expect(group.deletedAt).toBeUndefined();
    },
  );

  it("rejects invalid ownership before mutating history, and treats deleted groups as unavailable", () => {
    const group = groupFixture(),
      aggregate = new CollaborationGroupAggregate(group);
    const state = { ...stateFixture(), status: "idle" as const };
    expect(() =>
      aggregate.update({ ...group, ownerId: "missing" }, [state]),
    ).toThrow("身份必须唯一");
    expect(state.groupSnapshot).toBeUndefined();
    aggregate.delete([state], "2026-10-14");
    expect(() => aggregate.assertAvailable()).toThrow("已删除");
  });
});
