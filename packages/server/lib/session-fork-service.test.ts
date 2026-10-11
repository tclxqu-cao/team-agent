import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { getDatabase, SQLiteProjectStore, SQLiteSessionStore, sessionHistoryMessageId, type ISessionStore, type Session } from "@agent/core";
import { forkCustomerSession } from "./session-fork-service";

function fixture() {
  const source: Session = { id: "source", title: "original", projectId: "p1", status: "completed", created: "old", updated: "old", metadata: { permissionMode: "full-access", goalState: { pending: ["future goal"] } }, events: [{ type: "done", finalText: "future" }], messages: [
    { role: "user", content: "q1" },
    { role: "assistant", content: "", toolCalls: [{ id: "t1", name: "read", arguments: {} }] },
    { role: "tool", toolCallId: "t1", content: "file" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "q2" },
    { role: "assistant", content: "a2" },
    { role: "user", content: "q3" },
    { role: "assistant", content: "a3" },
  ] };
  const create = vi.fn(async (session: Session) => session);
  const replaceMessages = vi.fn(async () => undefined);
  const store = { get: async () => source, create, replaceMessages, delete: vi.fn(async () => undefined) } as unknown as ISessionStore;
  return { source, store, create, replaceMessages };
}

describe("Customer Agent turn forks", () => {
  it("copies two turns with tool results, excluding future conversation, events and queued goals", async () => {
    const { store, source, create, replaceMessages } = fixture();
    const forked = await forkCustomerSession(store, source.id, { messageId: sessionHistoryMessageId(4, source.messages[5]) }, true);
    expect(forked.projectId).toBe("p1");
    const copy = create.mock.calls[0][0];
    expect(replaceMessages).toHaveBeenCalledWith(copy.id, source.messages.slice(0, 6));
    expect(copy.events).toEqual([]);
    expect(copy.metadata).toEqual({ permissionMode: "full-access", forkedFrom: "source" });
    expect(source.messages).toHaveLength(8);
    expect(copy.messages).not.toBe(source.messages);
  });
  it("rejects a current unfinished turn without creating a session", async () => {
    const { store, source, create } = fixture();
    await expect(forkCustomerSession(store, source.id, { messageId: sessionHistoryMessageId(6, source.messages[7]) }, true)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
  it("persists the selected prefix for a fresh SQLite reader and preserves the source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "customer-turn-fork-"));
    const store = new SQLiteSessionStore(dir);
    const { source } = fixture();
    try {
      await new SQLiteProjectStore(dir).create({
        id: source.projectId, name: "Fork project", description: dir,
        created: source.created, updated: source.updated,
      });
      await store.create({ ...source, messages: [], events: [] });
      await store.replaceMessages(source.id, source.messages);
      const forked = await forkCustomerSession(store, source.id, {
        messageId: sessionHistoryMessageId(4, source.messages[5]),
      }, false);
      const reader = new SQLiteSessionStore(dir);
      const copy = await reader.get(forked.id);
      expect(copy?.messages).toEqual(source.messages.slice(0, 6));
      expect(copy?.metadata).toEqual({ permissionMode: "full-access", forkedFrom: source.id });
      expect(copy?.events).toEqual([]);
      expect(copy?.status).toBe("idle");
      expect(copy?.projectId).toBe(source.projectId);
      expect((await reader.get(source.id))?.messages).toEqual(source.messages);
    } finally {
      getDatabase(dir).close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("removes the incomplete copy if storing its transcript fails", async () => {
    const { store, source, create, replaceMessages } = fixture();
    const failure = new Error("transcript write failed");
    replaceMessages.mockRejectedValueOnce(failure);
    await expect(forkCustomerSession(store, source.id, {
      messageId: sessionHistoryMessageId(4, source.messages[5]),
    }, false)).rejects.toBe(failure);
    expect(store.delete).toHaveBeenCalledWith(create.mock.calls[0][0].id);
    expect(source.messages).toHaveLength(8);
  });
});
