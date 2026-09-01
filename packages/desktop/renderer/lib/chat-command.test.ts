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

  it("truncates the session title to 60 characters", async () => {
    const titles: string[] = [];

    await prepareChatCommand({
      text: "x".repeat(120),
      projectId: null,
      sessionId: null,
      createSession: async (title) => {
        titles.push(title);
        return { id: "session-new" };
      },
      activateSession: () => {},
      showUserMessage: () => {},
    });

    expect(titles).toEqual(["x".repeat(60)]);
  });

  it("falls back to a default title when the message is empty", async () => {
    const titles: string[] = [];

    await prepareChatCommand({
      text: "",
      projectId: null,
      sessionId: null,
      createSession: async (title) => {
        titles.push(title);
        return { id: "session-new" };
      },
      activateSession: () => {},
      showUserMessage: () => {},
    });

    expect(titles).toEqual(["New Session"]);
  });

  it("normalizes a null or empty project id to undefined", async () => {
    const seen: Array<string | undefined> = [];

    for (const projectId of [null, ""]) {
      await prepareChatCommand({
        text: "hi",
        projectId,
        sessionId: null,
        createSession: async (_title, id) => {
          seen.push(id);
          return { id: "session-new" };
        },
        activateSession: () => {},
        showUserMessage: () => {},
      });
    }

    expect(seen).toEqual([undefined, undefined]);
  });

  it("trims whitespace around the created session id", async () => {
    const activated: string[] = [];

    const sessionId = await prepareChatCommand({
      text: "hi",
      projectId: null,
      sessionId: null,
      createSession: async () => ({ id: "  session-padded  " }),
      activateSession: (id) => activated.push(id),
      showUserMessage: () => {},
    });

    expect(sessionId).toBe("session-padded");
    expect(activated).toEqual(["session-padded"]);
  });

  it("awaits an async onSessionCreated before returning", async () => {
    const order: string[] = [];

    await prepareChatCommand({
      text: "hi",
      projectId: null,
      sessionId: null,
      createSession: async () => ({ id: "session-new" }),
      activateSession: () => {},
      showUserMessage: () => {},
      onSessionCreated: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("onSessionCreated");
      },
    });
    order.push("returned");

    expect(order).toEqual(["onSessionCreated", "returned"]);
  });

  it("propagates failures from onSessionCreated", async () => {
    await expect(prepareChatCommand({
      text: "hi",
      projectId: null,
      sessionId: null,
      createSession: async () => ({ id: "session-new" }),
      activateSession: () => {},
      showUserMessage: () => {},
      onSessionCreated: async () => {
        throw new Error("sidebar refresh failed");
      },
    })).rejects.toThrow("sidebar refresh failed");
  });

  it("skips onSessionCreated when reusing an existing session", async () => {
    const onSessionCreated = vi.fn();

    await prepareChatCommand({
      text: "hi",
      projectId: null,
      sessionId: "session-existing",
      createSession: async () => ({ id: "unexpected" }),
      activateSession: () => {},
      showUserMessage: () => {},
      onSessionCreated,
    });

    expect(onSessionCreated).not.toHaveBeenCalled();
  });
});
