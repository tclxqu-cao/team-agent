import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteCollaborationRepository } from "./SQLiteCollaborationRepository.js";
import { getDatabase } from "./SQLiteDatabase.js";
import {
  groupFixture,
  stateFixture,
} from "../domain/collaboration/__tests__/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    getDatabase(dir).close();
    rmSync(dir, { recursive: true, force: true });
  }
});
function store() {
  const dir = mkdtempSync(join(tmpdir(), "collaboration-repository-"));
  dirs.push(dir);
  return { dir, repo: new SQLiteCollaborationRepository(dir) };
}
describe("SQLite collaboration persistence", () => {
  it("reopens edited groups and tombstones and rolls back rejected group/history mutations", () => {
    const { dir, repo } = store();
    repo.saveGroup(groupFixture());
    repo.createDiscussion(stateFixture());
    expect(() => repo.updateGroup("g", (group, discussions) => {
      group.name = "不保存";
      discussions[0].messages = [];
      throw new Error("reject");
    })).toThrow("reject");
    expect(repo.getGroup("g")?.name).toBe("协作群");
    repo.updateGroup("g", (group, discussions) => {
      discussions[0].groupSnapshot = structuredClone(group);
      group.name = "已修改";
    });
    const reopened = new SQLiteCollaborationRepository(dir);
    expect(reopened.listGroups()[0].name).toBe("已修改");
    expect(reopened.getDiscussion("d")?.groupSnapshot?.name).toBe("协作群");
    reopened.updateGroup("g", group => { group.deletedAt = "2026-10-14"; });
    const afterDelete = new SQLiteCollaborationRepository(dir);
    expect(afterDelete.listGroups()).toEqual([]);
    expect(afterDelete.getDiscussion("d")).not.toBeNull();
  });

  it("reopens the same history and keeps separate discussions and their revisions", () => {
    const { dir, repo } = store();
    repo.saveGroup(groupFixture());
    repo.createDiscussion(stateFixture());
    repo.updateDiscussion("d", (s) => {
      s.messages.push({
        id: "m",
        kind: "user",
        content: "历史消息",
        createdAt: "2026-10-14",
      });
    });
    repo.createDiscussion({ ...stateFixture(), id: "d2", messages: [] });
    const reopened = new SQLiteCollaborationRepository(dir);
    expect(reopened.getDiscussion("d")?.messages[0].content).toBe("历史消息");
    expect(reopened.getDiscussion("d")?.revision).toBe(1);
    expect(reopened.getDiscussion("d2")?.messages).toEqual([]);
    expect(reopened.listDiscussions("g")).toHaveLength(2);
  });
  it("rolls back a rejected aggregate mutation and grants a single scheduler lease", () => {
    const { repo } = store();
    repo.saveGroup(groupFixture());
    repo.createDiscussion(stateFixture());
    expect(() =>
      repo.updateDiscussion("d", (s) => {
        s.title = "不应保存";
        throw new Error("reject");
      }),
    ).toThrow("reject");
    expect(repo.getDiscussion("d")?.title).toBe("新讨论");
    expect(repo.claim("d", "host-a", 100, 100)).toBe(true);
    expect(repo.claim("d", "host-b", 110, 100)).toBe(false);
    expect(repo.claim("d", "host-b", 201, 100)).toBe(true);
    repo.release("d", "host-a");
    expect(repo.claim("d", "host-a", 210, 100)).toBe(false);
  });
  it("locks shared directories across discussions without locking independent worktrees", () => {
    const { repo } = store();
    expect(repo.claimWorkspace("/project", "d/a", 100, 100)).toBe(true);
    expect(repo.claimWorkspace("/project", "d2/b", 110, 100)).toBe(false);
    expect(repo.claimWorkspace("/worktree", "d2/b", 110, 100)).toBe(true);
    repo.releaseWorkspace("/project", "wrong-owner");
    expect(repo.claimWorkspace("/project", "d2/b", 120, 100)).toBe(false);
    repo.releaseWorkspace("/project", "d/a");
    expect(repo.claimWorkspace("/project", "d2/b", 130, 100)).toBe(true);
  });
  it("shares read leases across hosts while excluding a writer until every reader releases", () => {
    const { dir, repo } = store(),
      other = new SQLiteCollaborationRepository(dir);
    expect(repo.claimWorkspace("/project", "a", 100, 100, true)).toBe(true);
    expect(other.claimWorkspace("/project", "b", 110, 100, true)).toBe(true);
    expect(other.claimWorkspace("/project", "writer", 120, 100)).toBe(false);
    repo.releaseWorkspace("/project", "a");
    expect(other.claimWorkspace("/project", "writer", 130, 100)).toBe(false);
    other.releaseWorkspace("/project", "b");
    expect(other.claimWorkspace("/project", "writer", 140, 100)).toBe(true);
    expect(repo.claimWorkspace("/project", "reader", 150, 100, true)).toBe(
      false,
    );
  });
});
