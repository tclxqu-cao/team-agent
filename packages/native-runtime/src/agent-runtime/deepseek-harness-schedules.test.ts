import { describe, expect, it, vi } from "vitest";
import { DeepSeekHarnessScheduleClient } from "./deepseek-harness-schedules.js";
import type { HarnessConnection } from "./deepseek-harness-client.js";
import * as endpoints from "./deepseek-harness-endpoint.js";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

function setup() {
  const request = vi.fn<HarnessConnection["request"]>();
  const dispose = vi.fn(async () => {});
  const connection: HarnessConnection = { request, dispose, follow: vi.fn() };
  return { request, dispose, client: new DeepSeekHarnessScheduleClient(connection) };
}

describe("native Harness schedule cancellation", () => {
  it("cancels an exact task/session pair and verifies absence without touching other tasks", async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ id: "task", deleted: true }).mockResolvedValueOnce([{ id: "unrelated", sessionId: "other" }]);
    await s.client.cancel("owner", "task");
    expect(s.request.mock.calls).toEqual([
      ["schedule/delete", { request: { sessionId: "owner", id: "task" } }],
      ["schedule/catalog", {}],
    ]);
    await s.client.dispose();
    expect(s.dispose).toHaveBeenCalledOnce();
  });
  it("accepts an already absent task so deletion retries are idempotent", async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ id: "task", deleted: false, code: "schedule_not_found" }).mockResolvedValueOnce([]);
    await expect(s.client.cancel("owner", "task")).resolves.toBeUndefined();
  });
  it("rejects a wrong session binding when the task still exists under another owner", async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ id: "task", deleted: false, code: "schedule_not_found" }).mockResolvedValueOnce([{ id: "task", sessionId: "real-owner" }]);
    await expect(s.client.cancel("wrong-owner", "task")).rejects.toThrow("仍存在");
  });
  it("rejects a success receipt if readback still contains the task", async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ id: "task", deleted: true }).mockResolvedValueOnce([{ id: "task" }]);
    await expect(s.client.cancel("owner", "task")).rejects.toThrow("仍存在");
  });
  it("rejects mismatched receipts and malformed readback", async () => {
    const s = setup();
    s.request.mockResolvedValueOnce({ id: "another", deleted: true });
    await expect(s.client.cancel("owner", "task")).rejects.toThrow("回执无效");
    s.request.mockResolvedValueOnce({ id: "task", deleted: true }).mockResolvedValueOnce({ tasks: [] });
    await expect(s.client.cancel("owner", "task")).rejects.toThrow("回读无效");
  });
  it("propagates scheduler errors and never starts another Host when the owner is unavailable", async () => {
    const s = setup(); s.request.mockRejectedValueOnce(new Error("host offline"));
    await expect(s.client.cancel("owner", "task")).rejects.toThrow("host offline");
    const discover = vi.spyOn(endpoints, "discoverHarnessEndpoint").mockResolvedValue(null);
    const spawn = vi.mocked(childProcess.spawn).mockImplementation(() => { throw new Error("must not spawn"); });
    const client = new DeepSeekHarnessScheduleClient();
    try {
      await expect(client.cancel("owner", "task")).rejects.toThrow("未运行");
      expect(spawn).not.toHaveBeenCalled();
    } finally { await client.dispose(); discover.mockRestore(); spawn.mockReset(); }
  });
});
