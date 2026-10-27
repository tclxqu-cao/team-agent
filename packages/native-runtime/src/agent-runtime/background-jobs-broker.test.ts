import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { NativeRuntimeBrokerClient, NativeRuntimeBrokerHost } from "./native-runtime-broker";
import { encodeUnifiedSessionId } from "./session-id";
import { UnifiedSessionService } from "./unified-session-service";
import type { AgentRuntimeAdapter, RuntimeBackgroundJob, UnifiedSessionSummary } from "./types";
import { RuntimeSessionError } from "./types";

const nativeId = "tasks-native";
const id = encodeUnifiedSessionId("deepseek-harness", nativeId);
const summary: UnifiedSessionSummary = {
  id, nativeSessionId: nativeId, agentType: "deepseek-harness", title: "Task controls",
  cwd: "/tmp", created: "2026-10-26T00:00:00Z", updated: "2026-10-26T00:00:00Z",
  status: "idle", occupancy: "available", sourceLabel: "test", canResume: true, canDelete: false,
};

function fixture() {
  let finish!: () => void;
  let markStarted!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const adapter: AgentRuntimeAdapter = {
    agentType: "deepseek-harness",
    health: async () => ({ agentType: "deepseek-harness", label: "test", available: true }),
    discoverSessions: async () => [summary],
    getSession: async () => ({ ...summary, messages: [], events: [] }),
    create: async () => summary,
    run: async function* () {
      markStarted();
      await done;
      yield { type: "done", finalText: "finished" };
    },
    abort: vi.fn(async () => { finish(); }),
    answerQuestion: async () => false,
    dispose: async () => { finish(); },
  };
  return { adapter, finish, started };
}

describe("background task broker transport", () => {
  it("stops only the selected job through the socket while its owning turn stays active", async () => {
    const { adapter, started, finish } = fixture();
    const job: RuntimeBackgroundJob = {
      id: "bash-one", label: "silent command", kind: "bash", scope: "session",
      status: "running", startedAt: 1, outputBytes: 0, canStop: true,
    };
    const otherJob = { ...job, id: "bash-two", label: "other command" };
    adapter.listBackgroundJobs = vi.fn(async () => [job, otherJob]);
    adapter.getBackgroundJobOutput = vi.fn(async () => ({ job, output: "", truncated: false }));
    adapter.stopBackgroundJob = vi.fn(async () => {
      job.status = "killed";
      job.canStop = false;
      return { outcome: "requested" as const };
    });
    const directory = await mkdtemp(join(tmpdir(), "task-broker-"));
    const host = new NativeRuntimeBrokerHost(directory, new UnifiedSessionService([adapter], async () => []));
    try {
      await host.start();
      const client = new NativeRuntimeBrokerClient({ directory });
      await client.startRun(id, "keep running", undefined, "web");
      await started;
      const before = host.snapshot(id);
      expect(await client.listBackgroundJobs(id)).toHaveLength(2);
      expect(await client.getBackgroundJobOutput(id, job.id)).toMatchObject({ output: "", job: { status: "running" } });
      expect(await client.stopBackgroundJob(id, job.id)).toEqual({ outcome: "requested" });
      expect(adapter.listBackgroundJobs).toHaveBeenCalledWith(nativeId);
      expect(adapter.getBackgroundJobOutput).toHaveBeenCalledWith(nativeId, job.id);
      expect(adapter.stopBackgroundJob).toHaveBeenCalledOnce();
      expect(adapter.stopBackgroundJob).toHaveBeenCalledWith(nativeId, job.id);
      expect(adapter.abort).not.toHaveBeenCalled();
      expect(host.snapshot(id).runId).toBe(before.runId);
      expect(host.snapshot(id).events.some(({ event }) => event.type === "done")).toBe(false);
      await expect(client.startRun(id, "overlap")).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
      expect(await client.listBackgroundJobs(id)).toMatchObject([{ status: "killed" }, { status: "running" }]);
    } finally {
      finish();
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports unsupported adapters without starting or aborting a turn", async () => {
    const { adapter } = fixture();
    const directory = await mkdtemp(join(tmpdir(), "task-broker-"));
    const host = new NativeRuntimeBrokerHost(directory, new UnifiedSessionService([adapter], async () => []));
    try {
      await host.start();
      const client = new NativeRuntimeBrokerClient({ directory });
      await expect(client.listBackgroundJobs(id)).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
      await expect(client.getBackgroundJobOutput(id, "job")).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
      await expect(client.stopBackgroundJob(id, "job")).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
      expect(adapter.abort).not.toHaveBeenCalled();
      expect(host.snapshot(id).runId).toBeNull();
    } finally {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves missing task errors across the socket for both reads and stops", async () => {
    const { adapter } = fixture();
    const missing = async () => { throw new RuntimeSessionError("Task not visible", "BACKGROUND_JOB_NOT_FOUND"); };
    adapter.getBackgroundJobOutput = missing;
    adapter.stopBackgroundJob = missing;
    const directory = await mkdtemp(join(tmpdir(), "task-broker-"));
    const host = new NativeRuntimeBrokerHost(directory, new UnifiedSessionService([adapter], async () => []));
    try {
      await host.start();
      const client = new NativeRuntimeBrokerClient({ directory });
      await expect(client.getBackgroundJobOutput(id, "gone")).rejects.toMatchObject({ code: "BACKGROUND_JOB_NOT_FOUND" });
      await expect(client.stopBackgroundJob(id, "gone")).rejects.toMatchObject({ code: "BACKGROUND_JOB_NOT_FOUND" });
      expect(adapter.abort).not.toHaveBeenCalled();
    } finally {
      await host.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
