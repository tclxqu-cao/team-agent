import { describe, expect, it } from "vitest";
import { createComposerSubmission, createSuggestionSubmission } from "./chat-submission";

describe("chat submission descriptors", () => {
  it("captures and clones composer context", () => {
    const agentIds = ["agent-1"];
    const images = ["data:image/png;base64,abc"];
    const submission = createComposerSubmission({
      text: "  inspect this  ",
      agentIds,
      agentName: "Reviewer",
      images,
    });
    agentIds.push("agent-2");
    images.push("data:image/png;base64,def");

    expect(submission).toEqual({
      text: "inspect this",
      origin: "composer",
      applyGoalMode: true,
      clearComposer: true,
      restoreDraftOnFailure: true,
      agentIds: ["agent-1"],
      agentName: "Reviewer",
      images: ["data:image/png;base64,abc"],
    });
  });

  it("isolates suggestions from composer state", () => {
    expect(createSuggestionSubmission("  /whoami ")).toEqual({
      text: "/whoami",
      origin: "suggestion",
      applyGoalMode: false,
      clearComposer: false,
      restoreDraftOnFailure: false,
    });
  });
});
