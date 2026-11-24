import { describe, expect, it, vi } from "vitest";
import { canSteerQueuedMessage, steerQueuedMessage } from "./queued-message-steering";
import { markDurableMessageSteered, reconcileDurableQueuedMessages } from "./queued-message-order";
import { useAgentStore, type ChatMessage } from "../stores/agentStore";
import type { SessionGoalState } from "../../../shared/src/contracts/agent-api";
import { mergeProgressiveSessionHistoryPage } from "./session-history";

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

  it.each(["full", "core"] as const)("keeps an accepted steer visible through stale %s history until persistence catches up", (phase) => {
    const old: ChatMessage[] = [
      { id: "old-input", role: "user", content: "previous request", timestamp: 1 },
      { id: "old-reply", role: "assistant", content: "working", timestamp: 2 },
    ];
    const input: ChatMessage = { ...message, role: "user", queueItemId: "queue-1", isSteering: true,
      images: ["data:image/png;base64,original"], timestamp: 3 };
    const accepted = markDurableMessageSteered([...old, input], input.id, 4);
    const history = phase === "core" ? { delivery: "core" as const, revision: "rev" } : undefined;
    let visible = mergeProgressiveSessionHistoryPage(accepted, old, phase, history);
    visible = reconcileDurableQueuedMessages(visible, { active: null, queued: [], history: [] });
    expect(visible.find(entry => entry.id === input.id)).toMatchObject({
      isSteered: true, isQueued: false, awaitingHistory: true, images: input.images,
    });
    const persisted: ChatMessage = { id: "history-message.v1.2.input", role: "user", content: input.content, timestamp: 5 };
    visible = mergeProgressiveSessionHistoryPage(visible, [...old, persisted], phase, history);
    const copies = visible.filter(entry => entry.role === "user" && entry.content === input.content);
    expect(copies).toHaveLength(1);
    expect(copies[0].awaitingHistory).toBeUndefined();
    expect(copies[0].images).toEqual(input.images);
    const lateQueue: SessionGoalState = { active: null, history: [], queued: [{
      id: "queue-1", sessionId: "session", sourceMessageId: input.id, kind: "message", objective: input.content,
      status: "queued", position: 0, createdAt: 1, updatedAt: 1,
    }] };
    visible = reconcileDurableQueuedMessages(visible, lateQueue);
    expect(visible.filter(entry => entry.role === "user" && entry.content === input.content)).toHaveLength(1);
    expect(visible.some(entry => entry.isQueued)).toBe(false);
  });

  it("keeps a completed steering receipt visible when it arrives before the HTTP acknowledgement", () => {
    const old: ChatMessage[] = [{ id: "working", role: "assistant", content: "working", timestamp: 1 }];
    const input: ChatMessage = { ...message, role: "user", queueItemId: "queue-1", isSteering: true };
    const completed: SessionGoalState = { active: null, queued: [], history: [{
      id: "queue-1", sessionId: "session", kind: "message", sourceMessageId: input.id, objective: input.content,
      status: "completed", position: 0, createdAt: 1, updatedAt: 2, lastReason: "steered",
    }] };
    let visible = reconcileDurableQueuedMessages([...old, input], completed);
    visible = mergeProgressiveSessionHistoryPage(visible, old, "full");
    visible = markDurableMessageSteered(visible, input.id, 4);
    expect(visible.find(entry => entry.id === input.id)).toMatchObject({ isSteered: true, awaitingHistory: true });
    const lateQueue: SessionGoalState = { active: null, queued: [{ ...completed.history[0], status: "queued" }], history: [] };
    visible = reconcileDurableQueuedMessages(visible, lateQueue);
    expect(visible.filter(entry => entry.id === input.id)).toHaveLength(1);
    expect(visible.find(entry => entry.id === input.id)?.isQueued).toBe(false);
  });

  it("preserves two accepted steering inputs independently while snapshots catch up", () => {
    const old: ChatMessage[] = [
      { id: "old-input", role: "user", content: message.content, timestamp: 1 },
      { id: "old-reply", role: "assistant", content: "working", timestamp: 2 },
    ];
    const first: ChatMessage = { ...message, role: "user", id: "first", queueItemId: "queue-1", timestamp: 3 };
    const second: ChatMessage = { ...first, id: "second", queueItemId: "queue-2", timestamp: 4 };
    let visible = markDurableMessageSteered([...old, first, second], first.id, 5);
    visible = markDurableMessageSteered(visible, second.id, 6);
    visible = mergeProgressiveSessionHistoryPage(visible, old, "full");
    expect(visible.filter(entry => entry.awaitingHistory).map(entry => entry.id)).toEqual(["first", "second"]);
    const persistedFirst: ChatMessage = { ...first, id: "history-message.v1.2.input", isQueued: undefined, queueItemId: undefined };
    visible = mergeProgressiveSessionHistoryPage(visible, [...old, persistedFirst], "full");
    expect(visible.filter(entry => entry.awaitingHistory).map(entry => entry.id)).toEqual(["second"]);
    const persistedSecond: ChatMessage = { ...persistedFirst, id: "history-message.v1.3.input" };
    visible = mergeProgressiveSessionHistoryPage(visible, [...old, persistedFirst, persistedSecond], "full");
    expect(visible.filter(entry => entry.role === "user")).toHaveLength(3);
    expect(visible.some(entry => entry.awaitingHistory)).toBe(false);
  });

  it("does not mark rejected legacy steering as accepted", async () => {
    const api = { steer: vi.fn().mockResolvedValue(false), steerSessionMessage: vi.fn() };
    await expect(steerQueuedMessage(message, "session", false, api)).rejects.toThrow("不支持插队");
  });

  it("does not silently strip images when a legacy service only accepts text steering", async () => {
    const api = { steer: vi.fn().mockResolvedValue(true), steerSessionMessage: vi.fn() };
    await expect(steerQueuedMessage({ ...message, images: ["data:image/png;base64,image"] }, "session", false, api)).rejects.toThrow("带图片");
    expect(api.steer).not.toHaveBeenCalled();
  });
});
