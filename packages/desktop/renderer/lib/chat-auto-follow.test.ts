import { describe, expect, it } from "vitest";
import { createChatAutoFollowController } from "./chat-auto-follow";

describe("chat auto follow", () => {
  it("stops following streaming updates after a manual upward scroll", () => {
    const controller = createChatAutoFollowController(160);

    expect(controller.shouldFollow(null)).toBe(true);
    expect(controller.onScroll(320)).toBe(true);
    expect(controller.shouldFollow(null)).toBe(false);
  });

  it("resumes after the reader returns to the bottom", () => {
    const controller = createChatAutoFollowController(160);
    controller.onScroll(320);

    expect(controller.onScroll(80)).toBe(false);
    expect(controller.shouldFollow(null)).toBe(true);
  });

  it("keeps following throughout a smooth return requested by the arrow", () => {
    const controller = createChatAutoFollowController(160);
    controller.onScroll(320);
    controller.requestReturn();

    controller.onScroll(240);
    expect(controller.shouldFollow(null)).toBe(true);
    controller.onScroll(0);
    expect(controller.isFollowing()).toBe(true);
  });

  it("honors history suppression but resets for an initial instant load", () => {
    const controller = createChatAutoFollowController(160);
    controller.onScroll(320);

    expect(controller.shouldFollow("skip")).toBe(false);
    expect(controller.shouldFollow("instant")).toBe(true);
  });
});
