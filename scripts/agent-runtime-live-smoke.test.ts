import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent/core";
import type {
  AgentRuntimeAdapter,
  RuntimeRunOptions,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "../packages/desktop/main/agent-runtime/types.js";
import {
  classifySmokeFailure,
  redactSensitive,
  runAgentRuntimeSmoke,
} from "./agent-runtime-live-smoke.js";

describe("agent runtime live smoke", () => {
  it("runs lifecycle, permission, controls, abort, and cleanup in order", async () => {
    const root = resolve(tmpdir(), `smoke-test-${crypto.randomUUID()}`);
    const adapter = new FakeAdapter(root, true);
    const summary = await runAgentRuntimeSmoke({
      agent: "codex",
      adapter,
      workspaceRoot: root,
      expectedVersion: "1.2.3",
      capabilities: { goal: true, steer: true, fork: true, archive: true },
      abortDelayMs: 1,
      eventTimeoutMs: 1_000,
    });

    expect(summary.success).toBe(true);
    expect(summary.runtimeVersion).toBe("codex 1.2.3");
    expect(summary.capabilities.filter((step) => step.status === "passed").map((step) => step.name)).toEqual([
      "workspace",
      "health",
      "workspace-discovery",
      "create-session",
      "first-turn-and-tool-permission",
      "first-history-read",
      "resume-second-turn",
      "second-history-read",
      "goal",
      "fork",
      "archive-fork",
      "steer",
      "abort",
    ]);
    expect(adapter.calls).toContain("answer:allow");
    expect(adapter.calls.at(-1)).toBe("dispose");
  });

  it("records unsupported optional controls as skipped", async () => {
    const root = resolve(tmpdir(), `smoke-test-${crypto.randomUUID()}`);
    const adapter = new FakeAdapter(root, false);
    const summary = await runAgentRuntimeSmoke({
      agent: "opencode",
      adapter,
      workspaceRoot: root,
      capabilities: {},
      abortDelayMs: 1,
      eventTimeoutMs: 1_000,
    });
    expect(summary.success).toBe(true);
    expect(summary.capabilities.filter((step) => step.status === "skipped").map((step) => step.name)).toEqual([
      "goal", "fork", "archive-fork", "steer",
    ]);
  });

  it("classifies an event timeout as compatibility and still aborts and disposes", async () => {
    const root = resolve(tmpdir(), `smoke-test-${crypto.randomUUID()}`);
    const adapter = new HangingAdapter(root, false);
    const summary = await runAgentRuntimeSmoke({
      agent: "claude",
      adapter,
      workspaceRoot: root,
      capabilities: {},
      eventTimeoutMs: 20,
    });
    expect(summary.success).toBe(false);
    expect(summary.failureCategory).toBe("compatibility");
    expect(adapter.aborted).toBe(true);
    expect(adapter.disposed).toBe(true);
  });

  it("redacts credential-shaped failure text", () => {
    const value = redactSensitive("Bearer abc.def token=topsecret api_key=sk-ant_abcdefghijk");
    expect(value).not.toContain("abc.def");
    expect(value).not.toContain("topsecret");
    expect(value).not.toContain("abcdefghijk");
  });

  it.each([
    ["HTTP 401 invalid API key", "authentication"],
    ["429 rate limit exceeded", "rate_limit"],
    ["npm registry packument unavailable", "registry"],
    ["spawn codex ENOENT", "runner"],
    ["native protocol changed", "compatibility"],
    ["unexpected failure", "unknown"],
  ] as const)("classifies %s", (message, category) => {
    expect(classifySmokeFailure(new Error(message))).toBe(category);
  });
});

class FakeAdapter implements AgentRuntimeAdapter {
  readonly agentType = "codex" as const;
  readonly calls: string[] = [];
  private readonly messages: UnifiedSessionDetail["messages"] = [];
  private abortRequested = false;
  private permissionAnswered = false;
  private runCount = 0;

  constructor(private readonly workspaceRoot: string, private readonly controls: boolean) {}

  async health() {
    this.calls.push("health");
    return { agentType: this.agentType, available: true, label: "Codex", version: "codex 1.2.3" };
  }

  async discoverSessions() {
    this.calls.push("discover");
    return [];
  }

  async listWorkspaces() {
    this.calls.push("workspaces");
    return { data: [], nextCursor: null, watermark: null };
  }

  async create(options: { title: string; cwd: string }) {
    this.calls.push("create");
    await mkdir(options.cwd, { recursive: true });
    return summary("session", options.cwd);
  }

  async getSession(nativeSessionId: string) {
    return { ...summary(nativeSessionId, this.workspaceRoot), messages: [...this.messages], events: [] };
  }

  async *run(_sessionId: string, input: string, _images?: string[], _agentIds?: string[], _agentName?: string, options?: RuntimeRunOptions): AsyncIterable<AgentEvent> {
    this.runCount += 1;
    this.calls.push(options?.goal ? "run:goal" : `run:${this.runCount}`);
    this.messages.push({ role: "user", content: input });
    if (input.includes("60 seconds")) {
      yield { type: "thinking", message: "waiting" };
      while (!this.abortRequested) await new Promise((resolveDelay) => setTimeout(resolveDelay, 1));
      yield { type: "turn_aborted" };
      return;
    }
    if (this.runCount === 1) {
      yield { type: "ask_user", questionId: "allow", question: "allow shell" };
      if (!this.permissionAnswered) throw new Error("permission answer missing");
      const proof = input.match(/exactly (agentroam-smoke-[\w-]+)/)?.[1];
      const workspace = input.includes("runtime-smoke-proof.txt")
        ? [...this.calls].includes("create") ? this.workspaceRoot : this.workspaceRoot
        : this.workspaceRoot;
      const directories = await import("node:fs/promises").then(({ readdir }) => readdir(workspace, { withFileTypes: true }));
      const smokeDir = directories.find((entry) => entry.isDirectory() && entry.name.startsWith("agentroam-smoke-"));
      await writeFile(resolve(workspace, smokeDir!.name, "runtime-smoke-proof.txt"), proof!);
    }
    this.messages.push({ role: "assistant", content: "ok" });
    yield { type: "text_chunk", text: "ok" };
    yield { type: "done", finalText: "ok" };
  }

  async steer() {
    this.calls.push("steer");
    return this.controls;
  }

  async abort() {
    this.calls.push("abort");
    this.abortRequested = true;
  }

  async answerQuestion() {
    this.calls.push("answer:allow");
    this.permissionAnswered = true;
    return true;
  }

  async fork() {
    this.calls.push("fork");
    return summary("fork", this.workspaceRoot);
  }

  async archiveSession(id: string) {
    this.calls.push(`archive:${id}`);
  }

  async dispose() {
    this.calls.push("dispose");
  }
}

class HangingAdapter extends FakeAdapter {
  aborted = false;
  disposed = false;

  override async *run(): AsyncIterable<AgentEvent> {
    await new Promise(() => undefined);
  }

  override async abort() {
    this.aborted = true;
  }

  override async dispose() {
    this.disposed = true;
  }
}

function summary(nativeSessionId: string, cwd: string): UnifiedSessionSummary {
  return {
    id: `runtime:codex:${nativeSessionId}`,
    agentType: "codex",
    nativeSessionId,
    title: "smoke",
    cwd,
    created: new Date(0).toISOString(),
    updated: new Date(0).toISOString(),
    status: "idle",
    occupancy: "available",
    sourceLabel: "fake",
    canResume: true,
    canDelete: false,
  };
}
