import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDatabase } from "./SQLiteDatabase.js";
import { SQLiteRemoteToolStore } from "./SQLiteRemoteToolStore.js";

const dirs: string[] = [];

function createStore() {
  const dir = mkdtempSync(join(tmpdir(), "remote-tools-"));
  dirs.push(dir);
  const db = getDatabase(dir).db;
  return { db, store: new SQLiteRemoteToolStore(db) };
}

function registerCourseTool(store: SQLiteRemoteToolStore) {
  store.upsertTools("kid-earth-learning", [{
    scheme: "create_kid_earth_course",
    purpose: "创建课程",
    url: "http://127.0.0.1:3000/api/agent-actions/create-course",
    method: "POST",
    headers: {},
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    examples: [],
    auth: { type: "bearer", tokenEnv: "AGENT_ACTION_TOKEN" },
  }]);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SQLiteRemoteToolStore", () => {
  it("upserts remote tools by projectId and scheme", () => {
    const { store } = createStore();
    store.upsertTools("kid-earth-learning", [{
      scheme: "create_kid_earth_course",
      purpose: "创建课程",
      url: "http://127.0.0.1:3000/api/agent-actions/create-course",
      method: "POST",
      headers: {},
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      examples: [],
      auth: { type: "bearer", tokenEnv: "AGENT_ACTION_TOKEN" },
    }]);
    store.upsertTools("kid-earth-learning", [{
      scheme: "create_kid_earth_course",
      purpose: "创建并发布课程",
      url: "http://127.0.0.1:3000/api/agent-actions/create-course",
      method: "POST",
      headers: { "x-project": "kid-earth" },
      inputSchema: { type: "object", properties: { title: { type: "string" } } },
      outputSchema: { type: "object" },
      examples: [{ input: { title: "揭秘太阳" } }],
      auth: { type: "bearer", tokenEnv: "AGENT_ACTION_TOKEN" },
    }]);

    const tools = store.listEnabledTools("kid-earth-learning");
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ scheme: "create_kid_earth_course", purpose: "创建并发布课程" });
    expect(tools[0].headers).toEqual({ "x-project": "kid-earth" });
  });

  it("creates jobs and records success or failure", () => {
    const { store } = createStore();
    registerCourseTool(store);
    const job = store.createJob("kid-earth-learning", "create_kid_earth_course", { title: "揭秘太阳" });
    expect(job.status).toBe("queued");

    store.markJobRunning(job.id);
    expect(store.getJob(job.id)?.status).toBe("running");

    store.markJobSucceeded(job.id, { ok: true, courseId: 12 });
    expect(store.getJob(job.id)).toMatchObject({ status: "succeeded", responsePayload: { ok: true, courseId: 12 } });

    const failed = store.createJob("kid-earth-learning", "create_kid_earth_course", { title: "失败课程" });
    store.markJobFailed(failed.id, "remote 500");
    expect(store.getJob(failed.id)).toMatchObject({ status: "failed", error: "remote 500" });
  });

  it("rejects jobs for unregistered tools without inserting a job", () => {
    const { db, store } = createStore();

    expect(() => store.createJob("kid-earth-learning", "missing", {})).toThrow(/not registered or disabled/);
    const jobCount = db.prepare("SELECT COUNT(*) AS count FROM remote_tool_jobs WHERE project_id = ?").get("kid-earth-learning") as { count: number };
    expect(jobCount.count).toBe(0);
  });

  it("clears stale success payload and records error when a job fails", () => {
    const { store } = createStore();
    registerCourseTool(store);
    const job = store.createJob("kid-earth-learning", "create_kid_earth_course", { title: "先成功后失败" });

    store.markJobSucceeded(job.id, { ok: true, courseId: 12 });
    store.markJobFailed(job.id, "remote 500");

    expect(store.getJob(job.id)).toMatchObject({
      status: "failed",
      responsePayload: null,
      error: "remote 500",
    });
  });
});
