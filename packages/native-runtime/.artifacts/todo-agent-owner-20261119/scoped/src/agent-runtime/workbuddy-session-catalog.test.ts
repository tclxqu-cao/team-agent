import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { WorkBuddyRuntimeAdapter } from "./workbuddy-runtime-adapter.js";
import { WorkBuddySessionCatalog } from "./workbuddy-session-catalog.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(status?: string, writerPid: number | null = process.pid) {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-activity-"));
  roots.push(root);
  await mkdir(join(root, "projects", "repo"), { recursive: true });
  await mkdir(join(root, "sessions"));
  await writeFile(join(root, "projects", "repo", "session.jsonl"), JSON.stringify({
    type: "message", role: "assistant", status: "completed", cwd: root,
    timestamp: Date.now(), content: "Finished",
  }) + "\n");
  if (writerPid !== null) {
    await writeFile(join(root, "sessions", `${writerPid}.json`), JSON.stringify({ pid: writerPid, sessionId: "session" }));
  }
  if (status !== undefined) updateStatus(root, status);
  const catalog = new WorkBuddySessionCatalog(root);
  const client = new WorkBuddyClient({ catalog, command: async () => { throw new Error("Must not start a native process"); } });
  return { root, catalog, client, adapter: new WorkBuddyRuntimeAdapter(client) };
}

function updateStatus(root: string, status: string) {
  const db = new DatabaseSync(join(root, "workbuddy.db"));
  try {
    db.exec("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, status TEXT)");
    db.prepare("INSERT OR REPLACE INTO sessions (id, status) VALUES (?, ?)").run("session", status);
  } finally { db.close(); }
}

describe("WorkBuddy native activity and ownership", () => {
  it.each(["completed", "error", "terminated", "archived"])("reports %s as idle while keeping a live desktop writer read-only", async status => {
    const { adapter, client, catalog } = await fixture(status);
    expect((await catalog.list())[0]).toMatchObject({ running: false, externallyOwned: true });
    expect((await adapter.discoverSessions())[0]).toMatchObject({
      status: "idle", occupancy: "owned-externally", canResume: false,
    });
    expect(await adapter.getSession("session")).toMatchObject({
      status: "idle", occupancy: "owned-externally", canResume: false,
      messages: [expect.objectContaining({ content: "Finished" })],
    });
    await expect(client.run("session", "Do not take over")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
  });

  it("refreshes native activity independently of the cached transcript", async () => {
    const { root, adapter } = await fixture("completed");
    expect((await adapter.discoverSessions())[0].status).toBe("idle");
    updateStatus(root, "running");
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "running", occupancy: "owned-externally" });
    updateStatus(root, "completed");
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "idle", occupancy: "owned-externally" });
  });

  it.each([null, 99_999_999])("does not report stale activity when the writer is absent or dead (%s)", async writerPid => {
    const { adapter } = await fixture("running", writerPid);
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "idle", occupancy: "available", canResume: true });
  });

  it("preserves the writer lock when the database is missing without creating a database", async () => {
    const { root, adapter } = await fixture();
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "running", occupancy: "owned-externally", canResume: false });
    expect(await readdir(root)).not.toContain("workbuddy.db");
  });

  it("preserves the writer lock if the native schema cannot be read", async () => {
    const { root, adapter } = await fixture();
    await writeFile(join(root, "workbuddy.db"), "temporarily unavailable database");
    expect((await adapter.discoverSessions())[0]).toMatchObject({ status: "running", occupancy: "owned-externally", canResume: false });
  });

  it("never modifies the native database during discovery or detail reads", async () => {
    const { root, adapter } = await fixture("completed");
    const before = await readFile(join(root, "workbuddy.db"));
    await adapter.discoverSessions();
    await adapter.getSession("session");
    expect(await readFile(join(root, "workbuddy.db"))).toEqual(before);
  });
});
