import { describe, expect, it, vi } from "vitest";
import { RemoteProjectActionTool } from "./RemoteProjectActionTool.js";
import type { RemoteToolStore } from "../../remote-tools/RemoteToolStore.js";
import type { RemoteToolDefinition, RemoteToolJob, RemoteToolRegistration } from "../../remote-tools/entities.js";

class MemoryStore implements RemoteToolStore {
  tools = new Map<string, RemoteToolDefinition>();
  jobs = new Map<string, RemoteToolJob>();
  upsertTools(projectId: string, tools: RemoteToolRegistration[]) { return tools.map((tool) => { const row = { id: tool.scheme, projectId, scheme: tool.scheme, purpose: tool.purpose, url: tool.url, method: "POST" as const, headers: tool.headers ?? {}, inputSchema: tool.inputSchema ?? {}, outputSchema: tool.outputSchema ?? {}, examples: tool.examples ?? [], auth: tool.auth ?? {}, enabled: true, createdAt: "now", updatedAt: "now" }; this.tools.set(`${projectId}:${tool.scheme}`, row); return row; }); }
  listEnabledTools(projectId: string) { return [...this.tools.values()].filter((tool) => tool.projectId === projectId && tool.enabled); }
  getTool(projectId: string, scheme: string) { return this.tools.get(`${projectId}:${scheme}`) ?? null; }
  createJob(projectId: string, scheme: string, requestPayload: Record<string, unknown>) { const job = { id: `job-${this.jobs.size + 1}`, projectId, scheme, requestPayload, status: "queued" as const, responsePayload: null, error: null, createdAt: "now", updatedAt: "now" }; this.jobs.set(job.id, job); return job; }
  markJobRunning(id: string) { this.jobs.set(id, { ...this.jobs.get(id)!, status: "running" }); }
  markJobSucceeded(id: string, responsePayload: Record<string, unknown>) { this.jobs.set(id, { ...this.jobs.get(id)!, status: "succeeded", responsePayload }); }
  markJobFailed(id: string, error: string) { this.jobs.set(id, { ...this.jobs.get(id)!, status: "failed", error }); }
  getJob(id: string) { return this.jobs.get(id) ?? null; }
}

describe("RemoteProjectActionTool", () => {
  it("creates a job and calls the registered URL without accepting a caller URL", async () => {
    const store = new MemoryStore();
    store.upsertTools("kid-earth-learning", [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api/agent-actions/create-course", method: "POST", auth: { type: "bearer", tokenEnv: "AGENT_ACTION_TOKEN" } }]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, courseId: 12 }), { status: 200, headers: { "content-type": "application/json" } }));
    const tool = new RemoteProjectActionTool({ store, projectId: "kid-earth-learning", fetchImpl, actionToken: "secret" });

    const result = await tool.execute({ action: "create_kid_earth_course", payload: { title: "揭秘太阳", url: "http://evil" } }, { workingDirectory: "/tmp", sessionId: "s1" });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toMatchObject({ status: "queued", jobId: "job-1" });
    await vi.waitFor(() => expect(store.getJob("job-1")?.status).toBe("succeeded"));
    expect(fetchImpl).toHaveBeenCalledWith("http://kid/api/agent-actions/create-course", expect.objectContaining({ method: "POST", headers: expect.objectContaining({ authorization: "Bearer secret" }) }));
  });

  it("returns job status", async () => {
    const store = new MemoryStore();
    const job = store.createJob("kid-earth-learning", "create_kid_earth_course", { title: "揭秘太阳" });
    store.markJobSucceeded(job.id, { ok: true, courseId: 12 });
    const tool = new RemoteProjectActionTool({ store, projectId: "kid-earth-learning", fetchImpl: fetch, actionToken: "secret" });

    const result = await tool.execute({ action: "remote_job_status", payload: { jobId: job.id } }, { workingDirectory: "/tmp", sessionId: "s1" });

    expect(JSON.parse(result.content)).toEqual({ status: "succeeded", result: { ok: true, courseId: 12 } });
  });

  it("does not return another project's job status", async () => {
    const store = new MemoryStore();
    const otherJob = store.createJob("other-project", "create_kid_earth_course", { title: "其它项目" });
    store.markJobSucceeded(otherJob.id, { ok: true, courseId: 99 });
    const tool = new RemoteProjectActionTool({ store, projectId: "kid-earth-learning", fetchImpl: fetch, actionToken: "secret" });

    const result = await tool.execute({ action: "remote_job_status", payload: { jobId: otherJob.id } }, { workingDirectory: "/tmp", sessionId: "s1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`Unknown remote job: ${otherJob.id}`);
  });

  it("includes registered static headers with authorization for remote execution", async () => {
    const store = new MemoryStore();
    store.upsertTools("kid-earth-learning", [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api/agent-actions/create-course", method: "POST", headers: { "x-project-key": "kid-earth" }, auth: { type: "bearer", tokenEnv: "AGENT_ACTION_TOKEN" } }]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const tool = new RemoteProjectActionTool({ store, projectId: "kid-earth-learning", fetchImpl, actionToken: "secret" });

    await tool.execute({ action: "create_kid_earth_course", payload: { title: "揭秘太阳" } }, { workingDirectory: "/tmp", sessionId: "s1" });

    await vi.waitFor(() => expect(store.getJob("job-1")?.status).toBe("succeeded"));
    expect(fetchImpl).toHaveBeenCalledWith("http://kid/api/agent-actions/create-course", expect.objectContaining({ headers: expect.objectContaining({ "x-project-key": "kid-earth", authorization: "Bearer secret" }) }));
  });

  it("strips registered authorization headers before applying the configured action token", async () => {
    const store = new MemoryStore();
    store.upsertTools("kid-earth-learning", [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api/agent-actions/create-course", method: "POST", headers: { Authorization: "Bearer attacker", "x-project-key": "kid-earth" }, auth: { type: "bearer", tokenEnv: "AGENT_ACTION_TOKEN" } }]);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const tool = new RemoteProjectActionTool({ store, projectId: "kid-earth-learning", fetchImpl, actionToken: "secret" });

    await tool.execute({ action: "create_kid_earth_course", payload: { title: "揭秘太阳" } }, { workingDirectory: "/tmp", sessionId: "s1" });

    await vi.waitFor(() => expect(store.getJob("job-1")?.status).toBe("succeeded"));
    const fetchCalls = fetchImpl.mock.calls as unknown as Array<[string, RequestInit]>;
    const requestInit = fetchCalls[0][1];
    const sentHeaders = requestInit.headers as Record<string, string>;
    expect(sentHeaders).toEqual({ "x-project-key": "kid-earth", "content-type": "application/json", authorization: "Bearer secret" });
    expect(Object.keys(sentHeaders).filter((key) => key.toLowerCase() === "authorization")).toEqual(["authorization"]);
    expect(Object.values(sentHeaders)).not.toContain("Bearer attacker");
  });

  it("returns an error result when creating a remote job fails", async () => {
    const store = new MemoryStore();
    store.upsertTools("kid-earth-learning", [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api/agent-actions/create-course", method: "POST" }]);
    store.createJob = () => { throw new Error("store unavailable"); };
    const tool = new RemoteProjectActionTool({ store, projectId: "kid-earth-learning", fetchImpl: fetch, actionToken: "secret" });

    const result = await tool.execute({ action: "create_kid_earth_course", payload: { title: "揭秘太阳" } }, { workingDirectory: "/tmp", sessionId: "s1" });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("store unavailable");
  });

  it("catches running-state failures without rejecting or calling the remote action", async () => {
    const store = new MemoryStore();
    store.upsertTools("kid-earth-learning", [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api/agent-actions/create-course", method: "POST" }]);
    store.markJobRunning = () => { throw new Error("running state unavailable"); };
    const markFailed = vi.spyOn(store, "markJobFailed");
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));
    const unhandledReasons: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandledReasons.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      const tool = new RemoteProjectActionTool({ store, projectId: "kid-earth-learning", fetchImpl, actionToken: "secret" });

      const result = await tool.execute({ action: "create_kid_earth_course", payload: { title: "揭秘太阳" } }, { workingDirectory: "/tmp", sessionId: "s1" });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(result.isError).toBeFalsy();
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(markFailed).toHaveBeenCalledWith("job-1", "running state unavailable");
      expect(store.getJob("job-1")?.status).toBe("failed");
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects unknown schemes", async () => {
    const tool = new RemoteProjectActionTool({ store: new MemoryStore(), projectId: "kid-earth-learning", fetchImpl: fetch, actionToken: "secret" });
    const result = await tool.execute({ action: "missing", payload: {} }, { workingDirectory: "/tmp", sessionId: "s1" });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown remote action: missing");
  });
});
