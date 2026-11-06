import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDatabase } from "./SQLiteDatabase.js";
import { SQLiteSessionStore } from "./SQLiteSessionStore.js";

describe("SQLiteSessionStore", () => {
  it("lists summaries without reading or parsing message and event history", async () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-session-summaries-"));
    const store = new SQLiteSessionStore(base);
    const now = new Date().toISOString();
    try {
      await store.create({ id: "summary", projectId: "", title: "Summary only", status: "idle",
        messages: [], events: [], created: now, updated: now, metadata: { permissionMode: "safe" } });
      await store.addMessage("summary", { role: "user", content: "Loaded only on selection" });
      getDatabase(base).db.prepare("INSERT INTO events (session_id, type, data, timestamp) VALUES (?, ?, ?, ?)")
        .run("summary", "legacy", "unreadable historical JSON", Date.now());
      expect(await store.listSummaries()).toEqual([{
        id: "summary", projectId: "", parentSessionId: undefined, title: "Summary only", status: "idle",
        created: now, updated: now, metadata: { permissionMode: "safe" },
      }]);
      expect(await store.listSummaries("other-project")).toEqual([]);
      await expect(store.get("summary")).rejects.toThrow();
    } finally {
      getDatabase(base).close();
      rmSync(base, { recursive: true, force: true });
    }
  });
  it("round trips failed tool identity through addMessage and replaceMessages", async () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-session-store-"));
    const store = new SQLiteSessionStore(base);
    const now = new Date().toISOString();

    try {
      await store.create({
        id: "s1", projectId: "", title: "s1", status: "idle", messages: [], events: [],
        created: now, updated: now, metadata: {},
      });
      const failedTool = {
        role: "tool" as const,
        content: "command failed",
        toolCallId: "call-1",
        name: "bash",
        isError: true,
      };

      await store.addMessage("s1", failedTool);
      expect((await store.get("s1"))?.messages).toEqual([failedTool]);

      await store.replaceMessages("s1", [{ role: "user", content: "retry" }, failedTool]);
      expect((await store.get("s1"))?.messages).toEqual([
        { role: "user", content: "retry" },
        failedTool,
      ]);
    } finally {
      getDatabase(base).close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
