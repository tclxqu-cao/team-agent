import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteSessionStore, enqueueSessionMessage, writeSessionGoalState } from "@agent/core";
import { describe, it, expect, vi } from "vitest";
import { SharedCustomerQueue } from "./shared-customer-queue";

describe("server-owned Customer message queue", () => {
  it("shares pending messages, preserves payloads, edits/reorders, and drains after the client leaves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-queue-"));
    const store = new SQLiteSessionStore(dir);
    const now = new Date().toISOString();
    await store.create({ id: "s", title: "queue", projectId: "", status: "idle", messages: [], events: [], metadata: {}, created: now, updated: now });
    let busy = true;
    const run = vi.fn(async () => "completed" as const);
    const queue = new SharedCustomerQueue(store, () => busy, run, () => {}, async () => true);
    try {
      const first = await queue.enqueueMessage("s", "first", "source-1", { agentIds: ["role"], images: ["image"] });
      await queue.enqueueMessage("s", "second", "source-2");
      await queue.enqueueMessage("s", "first", "source-1");
      expect((await queue.get("s")).queued).toHaveLength(2);
      await queue.updateMessage("s", first.queued[0].id, "edited");
      const pending = await queue.get("s");
      await queue.reorder("s", pending.queued.map((item) => item.id).reverse(), true);
      const otherClient = new SQLiteSessionStore(dir);
      expect((await otherClient.get("s"))?.metadata).toMatchObject({ goalState: { queued: [{ objective: "second" }, { objective: "edited" }] } });
      busy = false;
      await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
      await vi.waitFor(async () => expect(await queue.get("s", false)).toMatchObject({ active: null, queued: [] }));
      expect(run.mock.calls.map((call) => (call as unknown as [string, { objective: string }])[1].objective)).toEqual(["second", "edited"]);
      expect(run).toHaveBeenLastCalledWith("s", expect.objectContaining({ messagePayload: { agentIds: ["role"], images: ["image"] } }));
    } finally { busy = false; await vi.waitFor(async () => expect((await queue.get("s", false)).active).toBeNull()); rmSync(dir, { recursive: true, force: true }); }
  });
  it("resumes a persisted queue in a fresh coordinator and preserves cancellation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shared-queue-restart-"));
    const store = new SQLiteSessionStore(dir); const now = new Date().toISOString();
    const queued = enqueueSessionMessage({ active: null, queued: [], history: [] }, { id: "pending", sessionId: "s", objective: "restore", sourceMessageId: "source", now: Date.now(), activate: false });
    await store.create({ id: "s", title: "restore", projectId: "", status: "idle", messages: [], events: [], metadata: writeSessionGoalState({}, queued), created: now, updated: now });
    let busy = true; const run = vi.fn(async () => "completed" as const);
    const queue = new SharedCustomerQueue(new SQLiteSessionStore(dir), () => busy, run, () => {}, async () => false);
    try {
      expect((await queue.get("s")).queued[0].objective).toBe("restore");
      await queue.cancel("s", "pending"); busy = false;
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(run).not.toHaveBeenCalled();
      expect(await queue.get("s", false)).toMatchObject({ active: null, queued: [] });
    } finally { busy = false; rmSync(dir, { recursive: true, force: true }); }
  });
});
