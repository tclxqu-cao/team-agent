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

  it("restores persisted messages for the active session", () => {
    const store = new ChatStore();
    store.startNewSession({ id: "session-1", title: "AI 助手", status: "idle", created: "now", updated: "now" });

    store.restoreSessionMessages("session-1", [
      { id: "m1", role: "user", content: "第一轮：创建日本课程", timestamp: 1 },
      { id: "m2", role: "assistant", content: "已创建日本课程", timestamp: 2 },
    ]);

    expect(store.messages).toEqual([
      expect.objectContaining({ role: "user", content: "第一轮：创建日本课程" }),
      expect.objectContaining({ role: "assistant", content: "已创建日本课程" }),
    ]);
  });
});
