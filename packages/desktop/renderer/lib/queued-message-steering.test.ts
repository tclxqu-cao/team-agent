import { describe, expect, it, vi } from "vitest";
import { canSteerQueuedMessage, steerQueuedMessage } from "./queued-message-steering";
import { markDurableMessageSteered, reconcileDurableQueuedMessages } from "./queued-message-order";
import { useAgentStore, type ChatMessage } from "../stores/agentStore";
import type { SessionGoalState } from "../global";

describe("queued message steering", () => {
  const message = { id: "source", role: "user", content: "use this now", timestamp: 1, isQueued: true };

  it("blocks raw steering while durable admission is pending, then consumes the queue ID", async () => {
    let resolveAdmission!: (id: string) => void;
    const admission = new Promise<string>((resolve) => { resolveAdmission = resolve; });
    const api = {
      steer: vi.fn().mockResolvedValue(true),
      steerSessionMessage: vi.fn().mockResolvedValue({ active: null, queued: [], history: [] }),
    };
    expect(canSteerQueuedMessage(message, true)).toBe(false);
    await expect(steerQueuedMessage(message, "session", true, api)).rejects.toThrow("正在保存");
    expect(api.steer).not.toHaveBeenCalled();
    expect(api.steerSessionMessage).not.toHaveBeenCalled();

    resolveAdmission("queue-1");
    const admitted = { ...message, queueItemId: await admission };
    expect(canSteerQueuedMessage(admitted, true)).toBe(true);
    await expect(steerQueuedMessage(admitted, "session", true, api)).resolves.toEqual({
      active: null, queued: [], history: [],
    });
    expect(api.steerSessionMessage).toHaveBeenCalledTimes(1);
    expect(api.steerSessionMessage).toHaveBeenCalledWith("session", "queue-1");
    expect(api.steer).not.toHaveBeenCalled();
  });

  it("keeps the queued input retryable when durable steering fails", async () => {
    const admitted = { ...message, queueItemId: "queue-1" };
    const api = {
      steer: vi.fn(),
      steerSessionMessage: vi.fn().mockRejectedValue(new Error("connection lost")),
    };
    await expect(steerQueuedMessage(admitted, "session", true, api)).rejects.toThrow("connection lost");
    expect(admitted.isQueued).toBe(true);
    expect(admitted.queueItemId).toBe("queue-1");
    expect(api.steer).not.toHaveBeenCalled();
  });

  it("keeps both messages when an empty queue snapshot arrives before steering acknowledgements", async () => {
    const sessionId = "steering-race";
    const otherSessionId = "unrelated-session";
    const first: ChatMessage = { ...message, role: "user", queueItemId: "queue-1", isSteering: true };
    const second: ChatMessage = { ...first, id: "second", queueItemId: "queue-2", timestamp: 2 };
    const unrelated: ChatMessage = { id: "other", role: "user", content: "other task", timestamp: 1 };
    const empty: SessionGoalState = { active: null, queued: [], history: [] };
    const accept = new Map<string, (state: SessionGoalState) => void>();
    const api = {
      steer: vi.fn(),
      steerSessionMessage: vi.fn((_sessionId: string, queueId: string) => new Promise<SessionGoalState>((resolve) => {
        accept.set(queueId, resolve);
      })),
    };
    const store = useAgentStore.getState();
    store.setMessages([first, second], sessionId);
    store.setMessages([unrelated], otherSessionId);
    const pending = [first, second].map(async (input) => {
      const state = await steerQueuedMessage(input, sessionId, true, api);
      store.setMessages(markDurableMessageSteered(store.getMessagesForSession(sessionId), input.id, 3), sessionId);
      store.setMessages(reconcileDurableQueuedMessages(store.getMessagesForSession(sessionId), state!), sessionId);
    });

    // The broker has consumed both inputs, but mobile HTTP responses are still in flight.
    store.setMessages(reconcileDurableQueuedMessages(store.getMessagesForSession(sessionId), empty), sessionId);
    expect(store.getMessagesForSession(sessionId).map((entry) => entry.id)).toEqual([first.id, second.id]);
    expect(store.getMessagesForSession(sessionId).every((entry) => entry.isQueued)).toBe(true);
    accept.get("queue-2")!(empty);
    await pending[1];
    accept.get("queue-1")!(empty);
    await pending[0];

    expect(store.getMessagesForSession(sessionId)).toHaveLength(2);
    expect(store.getMessagesForSession(sessionId).every((entry) => entry.isSteered && !entry.isQueued && !entry.isSteering)).toBe(true);
    expect(store.getMessagesForSession(otherSessionId)).toEqual([unrelated]);
    expect(api.steerSessionMessage).toHaveBeenCalledTimes(2);
    expect(api.steer).not.toHaveBeenCalled();
  });

  it("keeps the original queued payload retryable after a delayed steering rejection", async () => {
    const sessionId = "steering-rejection";
    const input: ChatMessage = {
      ...message, role: "user", queueItemId: "queue-1", isSteering: true,
      images: ["data:image/png;base64,original"], agentName: "original agent",
    };
    const store = useAgentStore.getState();
    store.setMessages([input], sessionId);
    let reject!: (error: Error) => void;
    const api = {
      steer: vi.fn(),
      steerSessionMessage: vi.fn(() => new Promise<SessionGoalState>((_resolve, fail) => { reject = fail; })),
    };
    const pending = steerQueuedMessage(input, sessionId, true, api).finally(() => {
      store.updateMessage(input.id, (entry) => ({ ...entry, isSteering: undefined }), sessionId);
    });
    store.setMessages(reconcileDurableQueuedMessages(store.getMessagesForSession(sessionId), {
      active: null, queued: [], history: [],
    }), sessionId);
    const rejected = expect(pending).rejects.toThrow("steering rejected");
    reject(new Error("steering rejected"));
    await rejected;
    expect(store.getMessagesForSession(sessionId)).toEqual([{ ...input, isSteering: undefined }]);
    expect(canSteerQueuedMessage(store.getMessagesForSession(sessionId)[0], true)).toBe(true);
    expect(store.getMessagesForSession(sessionId)[0].isSteered).toBeUndefined();
  });

  it("preserves accepted legacy steering without a durable queue", async () => {
    const api = { steer: vi.fn().mockResolvedValue(true), steerSessionMessage: vi.fn() };
    await expect(steerQueuedMessage(message, "session", false, api)).resolves.toBeUndefined();
    expect(api.steer).toHaveBeenCalledTimes(1);
    expect(api.steer).toHaveBeenCalledWith(message.content, "session", undefined);
    expect(api.steerSessionMessage).not.toHaveBeenCalled();
  });

  it("does not mark rejected legacy steering as accepted", async () => {
    const api = { steer: vi.fn().mockResolvedValue(false), steerSessionMessage: vi.fn() };
    await expect(steerQueuedMessage(message, "session", false, api)).rejects.toThrow("不支持插队");
  });
});
