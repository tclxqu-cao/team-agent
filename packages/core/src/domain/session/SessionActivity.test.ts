import { describe, expect, it } from "vitest";
import { projectSessionActivity, visibleWorkspaceIds } from "./SessionActivity";

describe("projectSessionActivity", () => {
  it("prioritizes explicit failures", () => {
    expect(projectSessionActivity({
      authoritativeStatus: "failed",
      locallyRunning: true,
      needsInput: true,
      stale: false,
    })).toBe("error");
  });

  it("does not animate an unconfirmed stale running summary", () => {
    expect(projectSessionActivity({
      authoritativeStatus: "running",
      locallyRunning: false,
      needsInput: false,
      stale: true,
    })).toBe("stale");
  });

  it("keeps a current local run active even when its remote summary is stale", () => {
    expect(projectSessionActivity({
      authoritativeStatus: "running",
      locallyRunning: true,
      needsInput: true,
      stale: true,
    })).toBe("needs-input");
  });

  it("projects authoritative running and idle summaries", () => {
    expect(projectSessionActivity({
      authoritativeStatus: "running",
      locallyRunning: false,
      needsInput: false,
      stale: false,
    })).toBe("running");
    expect(projectSessionActivity({
      authoritativeStatus: "idle",
      locallyRunning: false,
      needsInput: false,
      stale: false,
    })).toBe("idle");
  });
});

describe("visibleWorkspaceIds", () => {
  it("returns the selected workspace first and de-duplicates expanded workspaces", () => {
    expect(visibleWorkspaceIds("selected", ["other", "selected", "third"]))
      .toEqual(["selected", "other", "third"]);
  });

  it("supports no selected workspace", () => {
    expect(visibleWorkspaceIds(null, new Set(["one", "two"]))).toEqual(["one", "two"]);
  });
});
