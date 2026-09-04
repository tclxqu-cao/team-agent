import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getDatabase } from "./SQLiteDatabase.js";
import { SQLiteProjectStore } from "./SQLiteProjectStore.js";

describe("SQLiteProjectStore", () => {
  it("lists projects by creation time newest first, regardless of updates", async () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-project-store-"));
    const store = new SQLiteProjectStore(base);

    try {
      await store.create({
        id: "older",
        name: "Older",
        description: "",
        created: "2026-09-01T00:00:00.000Z",
        updated: "2026-09-04T00:00:00.000Z",
      });
      await store.create({
        id: "newer",
        name: "Newer",
        description: "",
        created: "2026-09-03T00:00:00.000Z",
        updated: "2026-09-03T00:00:00.000Z",
      });

      expect((await store.list()).map((project) => project.id)).toEqual(["newer", "older"]);
    } finally {
      getDatabase(base).close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
