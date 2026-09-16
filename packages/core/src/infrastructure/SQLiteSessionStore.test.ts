import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDatabase } from "./SQLiteDatabase.js";
import { SQLiteSessionStore } from "./SQLiteSessionStore.js";

describe("SQLiteSessionStore", () => {
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
