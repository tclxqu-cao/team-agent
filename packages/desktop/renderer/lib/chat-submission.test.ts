import { describe, expect, it } from "vitest";
import { createComposerSubmission, createSuggestionSubmission, restoreFailedComposerDraft } from "./chat-submission";

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
  it("allows a first message containing only images while keeping empty submissions empty", () => {
    const images = ["data:image/png;base64,YQ=="];
    expect(createComposerSubmission({ text: "  ", images })).toMatchObject({ text: "请查看图片。", images });
    expect(createComposerSubmission({ text: "  " }).text).toBe("");
  });
  it("restores rejected image messages alongside newer input without duplicating the same draft", () => {
    const failed = { content: "看第一张图", images: ["image-a"] };
    expect(restoreFailedComposerDraft({ text: "补充要求", images: ["image-b", "image-a"] }, failed)).toEqual({
      text: "看第一张图\n\n补充要求", images: ["image-a", "image-b"],
    });
    expect(restoreFailedComposerDraft({ text: failed.content, images: ["image-a"] }, failed)).toEqual({
      text: failed.content, images: ["image-a"],
    });
    expect(restoreFailedComposerDraft({ text: "看第一张图\n\n补充要求", images: ["image-a", "image-b"] }, failed)).toEqual({
      text: "看第一张图\n\n补充要求", images: ["image-a", "image-b"],
    });
  });
});
