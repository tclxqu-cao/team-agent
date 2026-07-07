import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { FileSystemSessionStore } from "./SessionStore.js";
import type { Session } from "./entities.js";

const tempDirs: string[] = [];

function session(id: string, projectId: string): Session {
  return {
    id,
    projectId,
    title: id,
    status: "idle",
    messages: [],
    events: [],
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-01T00:00:00.000Z",
    metadata: {},
  };
}

describe("FileSystemSessionStore", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("filters list results by projectId", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-sessions-"));
    tempDirs.push(dir);
    const store = new FileSystemSessionStore(dir);
    await store.create(session("project-a-session", "project-a"));
    await store.create(session("project-b-session", "project-b"));

    const projectASessions = await store.list("project-a");

    expect(projectASessions.map((item) => item.id)).toEqual(["project-a-session"]);
  });
});
