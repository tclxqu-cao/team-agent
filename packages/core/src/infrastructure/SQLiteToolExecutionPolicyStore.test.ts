import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabase } from "./SQLiteDatabase.js";
import { SQLiteToolExecutionPolicyStore } from "./SQLiteToolExecutionPolicyStore.js";
import type { ToolExecutionPolicy } from "../domain/tool/execution-policy.js";

const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agentroam-tool-policy-"));
  directories.push(directory);
  return { directory, store: new SQLiteToolExecutionPolicyStore(directory) };
}

function policy(): ToolExecutionPolicy {
  return {
    id: "readonly",
    name: "Read only",
    enabled: true,
    allowedTools: ["read_file"],
    filesystem: { readRoots: ["/tmp"], writeRoots: [], followSymlinks: false },
    commands: { mode: "deny", programs: [], inheritedEnvironment: [] },
    network: "deny",
    limits: { timeoutMs: 5_000, maxOutputBytes: 4_096 },
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    getDatabase(directory).close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SQLiteToolExecutionPolicyStore", () => {
  it("round trips, updates, lists, and deletes policies", async () => {
    const { store } = fixture();
    const created = await store.save(policy());
    expect(created.created).toBeTruthy();
    expect(await store.get("readonly")).toMatchObject({ name: "Read only", enabled: true });

    const updated = await store.save({ ...policy(), name: "Updated", enabled: false });
    expect(updated.created).toBe(created.created);
    expect(updated.name).toBe("Updated");
    expect(await store.list()).toHaveLength(1);
    await expect(store.delete("readonly")).resolves.toBe(true);
    await expect(store.delete("readonly")).resolves.toBe(false);
  });

  it("rejects malformed persisted definitions", async () => {
    const { directory, store } = fixture();
    getDatabase(directory).db.prepare(`
      INSERT INTO tool_execution_policies (id, name, enabled, definition, created, updated)
      VALUES ('broken', 'Broken', 1, '{', 'now', 'now')
    `).run();
    await expect(store.get("broken")).rejects.toThrow();
  });
});
