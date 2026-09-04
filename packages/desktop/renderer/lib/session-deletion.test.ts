import { describe, expect, it } from "vitest";
import {
  removeSessionFromCollections,
  removeSessionIdsFromIndex,
  removeSessionIdsFromWorkspacePartition,
  sessionDeletionConfirmation,
} from "./session-deletion";
import { emptyAgentWorkspacePartition } from "./agent-workspace-cache";

interface TestSession {
  id: string;
  parentSessionId?: string;
}

describe("session deletion", () => {
  it("distinguishes permanent Customer Agent deletion from native hiding", () => {
    expect(sessionDeletionConfirmation({ agentType: "customer-agent", title: "CA 会话" }))
      .toContain("永久删除");
    expect(sessionDeletionConfirmation({ agentType: "codex", title: "Codex 会话" }))
      .toContain("归档 Codex 会话");
  });

  it("removes a parent and its direct children from every collection", () => {
    const parent = { id: "parent" };
    const child = { id: "child", parentSessionId: "parent" };
    const unrelated = { id: "other" };

    const result = removeSessionFromCollections<TestSession>(
      { project: [parent, unrelated] },
      { parent: [child] },
      [parent, unrelated],
      "parent",
    );

    expect(result.sessionsByProject.project).toEqual([unrelated]);
    expect(result.childSessionsByParent).toEqual({});
    expect(result.otherLocalSessions).toEqual([unrelated]);
    expect(result.removedIds).toEqual(["parent", "child"]);
  });

  it("removes one child while preserving its siblings and unrelated roots", () => {
    const root = { id: "root" };
    const child = { id: "child", parentSessionId: "root" };
    const sibling = { id: "sibling", parentSessionId: "root" };
    const sessionsByProject = { project: [root] };

    const result = removeSessionFromCollections<TestSession>(
      sessionsByProject,
      { root: [child, sibling] },
      [],
      "child",
    );

    expect(result.sessionsByProject).toBe(sessionsByProject);
    expect(result.childSessionsByParent.root).toEqual([sibling]);
    expect(result.removedIds).toEqual(["child"]);
  });

  it("removes deleted ids from the persisted combined project index", () => {
    expect(removeSessionIdsFromIndex({
      first: [{ id: "deleted" }, { id: "kept" }],
      second: [{ id: "other" }],
    }, ["deleted"])).toEqual({
      first: [{ id: "kept" }],
      second: [{ id: "other" }],
    });
  });

  it("removes deleted ids from every cached page without dropping pagination state", () => {
    const partition = {
      ...emptyAgentWorkspacePartition(),
      selectedSessionId: "child",
      sessions: {
        first: {
          data: [{ id: "parent" }, { id: "kept" }],
          nextCursor: "page-2",
          loaded: true,
        },
        second: {
          data: [{ id: "child", parentSessionId: "parent" }, { id: "other" }],
          nextCursor: null,
          loaded: true,
        },
      },
    };

    const result = removeSessionIdsFromWorkspacePartition(partition, ["parent", "child"]);

    expect(result.selectedSessionId).toBeNull();
    expect(result.sessions.first).toEqual({
      data: [{ id: "kept" }],
      nextCursor: "page-2",
      loaded: true,
    });
    expect(result.sessions.second.data).toEqual([{ id: "other" }]);
  });
});
