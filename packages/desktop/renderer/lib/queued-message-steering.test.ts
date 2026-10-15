import { describe, expect, it, vi } from "vitest";
import { canSteerQueuedMessage, steerQueuedMessage } from "./queued-message-steering";

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
