import { describe, expect, it } from "vitest";
import { resolveHubSessionPlan } from "./session-choice";

describe("resolveHubSessionPlan", () => {
  it("keeps per-site persistent partitions without an imported profile", () => {
    expect(resolveHubSessionPlan("chatgpt", null)).toEqual({ kind: "partition", partition: "persist:aihub-chatgpt" });
    expect(resolveHubSessionPlan("gemini", undefined)).toEqual({ kind: "partition", partition: "persist:aihub-gemini" });
    expect(resolveHubSessionPlan("grok", "")).toEqual({ kind: "partition", partition: "persist:aihub-grok" });
  });

  it("shares one imported session across sites only after a completed import", () => {
    const profilePath = "/tmp/userData/ai-hub-browser-profile/current";
    expect(resolveHubSessionPlan("chatgpt", profilePath)).toEqual({ kind: "shared-imported", profilePath });
    expect(resolveHubSessionPlan("gemini", profilePath)).toEqual({ kind: "shared-imported", profilePath });
  });

  it("rejects relative paths and whitespace-only values", () => {
    expect(resolveHubSessionPlan("chatgpt", "relative/path")).toEqual({ kind: "partition", partition: "persist:aihub-chatgpt" });
    expect(resolveHubSessionPlan("chatgpt", "   ")).toEqual({ kind: "partition", partition: "persist:aihub-chatgpt" });
  });
});
