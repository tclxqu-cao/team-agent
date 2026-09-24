import { describe, expect, it } from "vitest";
import { refreshableWorkspaceIds } from "./visible-session-refresh";

describe("refreshableWorkspaceIds", () => {
  it("preserves visible order while excluding invalid and in-flight workspaces", () => {
    expect(refreshableWorkspaceIds(
      ["selected", "expanded", "invalid", "loading"],
      new Set(["invalid"]),
      new Set(["loading"]),
    )).toEqual(["selected", "expanded"]);
  });

  it("keeps an empty visible projection empty", () => {
    expect(refreshableWorkspaceIds([], new Set(), new Set())).toEqual([]);
  });
});
