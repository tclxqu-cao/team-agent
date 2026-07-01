import { describe, expect, it } from "vitest";
import { ChatStore } from "./ChatStore";

describe("ChatStore", () => {
  it("tracks unresolved ask_user questions so the main input can answer them", () => {
    const store = new ChatStore();

    store.addAskUser("q1", "请选择课程主题");

    expect(store.getPendingAskUser()?.questionId).toBe("q1");

    store.resolveAskUser("q1", "揭秘太阳");

    expect(store.getPendingAskUser()).toBeNull();
  });
});
