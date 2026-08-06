import { describe, expect, it } from "vitest";
import * as voiceCommand from "./voice-command";
import { prepareVoiceCommand } from "./voice-command";

describe("prepareVoiceCommand", () => {
  it("makes the first voice message live before selecting a new session", async () => {
    const calls: string[] = [];

    const sessionId = await prepareVoiceCommand({
      text: "帮我看一下退款进度",
      projectId: "refund",
      createSession: async () => {
        calls.push("create");
        return { id: "voice-session" };
      },
      activateSession: (id) => calls.push(`activate:${id}`),
      showUserMessage: (text, id) => calls.push(`message:${id}:${text}`),
      onSessionCreated: (id) => calls.push(`selected:${id}`),
    });

    expect(sessionId).toBe("voice-session");
    expect(calls).toEqual([
      "create",
      "activate:voice-session",
      "message:voice-session:帮我看一下退款进度",
      "selected:voice-session",
    ]);
  });

  it("reuses an active conversation session without creating another one", async () => {
    const calls: string[] = [];

    const sessionId = await prepareVoiceCommand({
      text: "再查一下到账时间",
      projectId: null,
      sessionId: "voice-session",
      createSession: async () => {
        calls.push("create");
        return { id: "unexpected" };
      },
      activateSession: (id) => calls.push(`activate:${id}`),
      showUserMessage: (text, id) => calls.push(`message:${id}:${text}`),
      onSessionCreated: (id) => calls.push(`selected:${id}`),
    });

    expect(sessionId).toBe("voice-session");
    expect(calls).toEqual([
      "activate:voice-session",
      "message:voice-session:再查一下到账时间",
    ]);
  });
});

describe("voice session reload guard", () => {
  it("keeps an active voice session from being replaced by an early DB snapshot", () => {
    expect("shouldSkipVoiceSessionReload" in voiceCommand).toBe(true);
    const shouldSkipVoiceSessionReload = (
      voiceCommand as unknown as {
        shouldSkipVoiceSessionReload: (
          runningSessionId: string | null,
          activeSessionId: string | null,
          targetSessionId: string,
        ) => boolean;
      }
    ).shouldSkipVoiceSessionReload;

    expect(shouldSkipVoiceSessionReload("voice-session", "voice-session", "voice-session")).toBe(true);
    expect(shouldSkipVoiceSessionReload("voice-session", null, "voice-session")).toBe(false);
  });

  it("does not clear an active voice session while parent selection catches up", () => {
    const shouldSkipVoiceSessionReload = (
      voiceCommand as unknown as {
        shouldSkipVoiceSessionReload: (
          runningSessionId: string | null,
          activeSessionId: string | null,
          targetSessionId: string | null,
        ) => boolean;
      }
    ).shouldSkipVoiceSessionReload;

    expect(shouldSkipVoiceSessionReload("voice-session", "voice-session", null)).toBe(true);
  });
});

describe("voice conversation lifetime", () => {
  it("renews the follow-up window when the matching voice run completes", () => {
    expect("renewVoiceConversation" in voiceCommand).toBe(true);
    const renewVoiceConversation = (
      voiceCommand as unknown as {
        renewVoiceConversation: (
          conversation: { sessionId: string; until: number } | null,
          completedSessionId: string,
          now: number,
        ) => { sessionId: string; until: number } | null;
      }
    ).renewVoiceConversation;

    expect(renewVoiceConversation({ sessionId: "voice-session", until: 10 }, "voice-session", 100)).toEqual({
      sessionId: "voice-session",
      until: 90_100,
    });
    expect(renewVoiceConversation({ sessionId: "voice-session", until: 10 }, "other-session", 100)).toEqual({
      sessionId: "voice-session",
      until: 10,
    });
  });
});
