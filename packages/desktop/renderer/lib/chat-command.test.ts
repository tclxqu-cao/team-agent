import { describe, expect, it, vi } from "vitest";
import { prepareChatCommand } from "./chat-command";

describe("prepareChatCommand", () => {
  it("creates and activates a new session before selecting it", async () => {
    const calls: string[] = [];

    const sessionId = await prepareChatCommand({
      text: "hello",
      projectId: "project-a",
      sessionId: null,
      createSession: async (title, projectId) => {
        calls.push(`create:${title}:${projectId}`);
        return { id: "session-new" };
      },
      activateSession: (id) => calls.push(`activate:${id}`),
      showUserMessage: (text, id) => calls.push(`message:${id}:${text}`),
      onSessionCreated: (id) => calls.push(`selected:${id}`),
    });

    expect(sessionId).toBe("session-new");
    expect(calls).toEqual([
      "create:hello:project-a",
      "activate:session-new",
      "message:session-new:hello",
      "selected:session-new",
    ]);
  });

  it("uses an existing session without creating or selecting it again", async () => {
    const calls: string[] = [];

    const sessionId = await prepareChatCommand({
      text: "continue",
      projectId: null,
      sessionId: "session-existing",
      createSession: async () => {
        calls.push("create");
        return { id: "unexpected" };
      },
      activateSession: (id) => calls.push(`activate:${id}`),
      showUserMessage: (text, id) => calls.push(`message:${id}:${text}`),
      onSessionCreated: (id) => calls.push(`selected:${id}`),
    });

    expect(sessionId).toBe("session-existing");
    expect(calls).toEqual([
      "activate:session-existing",
      "message:session-existing:continue",
    ]);
  });

  it("treats an empty session id as a new session", async () => {
    const calls: string[] = [];

    const sessionId = await prepareChatCommand({
      text: "recover after restart",
      projectId: "default",
      sessionId: "  ",
      createSession: async () => {
        calls.push("create");
        return { id: "session-recovered" };
      },
      activateSession: (id) => calls.push(`activate:${id}`),
      showUserMessage: (text, id) => calls.push(`message:${id}:${text}`),
      onSessionCreated: (id) => calls.push(`selected:${id}`),
    });

    expect(sessionId).toBe("session-recovered");
    expect(calls).toEqual([
      "create",
      "activate:session-recovered",
      "message:session-recovered:recover after restart",
      "selected:session-recovered",
    ]);
  });

  it("rejects an empty id returned by session creation", async () => {
    const activateSession = vi.fn();
    const showUserMessage = vi.fn();

    await expect(prepareChatCommand({
      text: "hello",
      projectId: null,
      sessionId: "",
      createSession: async () => ({ id: "" }),
      activateSession,
      showUserMessage,
    })).rejects.toThrow("服务端未返回会话 ID");

    expect(activateSession).not.toHaveBeenCalled();
    expect(showUserMessage).not.toHaveBeenCalled();
  });
});
