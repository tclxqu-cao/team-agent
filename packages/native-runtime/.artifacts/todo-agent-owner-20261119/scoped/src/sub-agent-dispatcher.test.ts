import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getDatabase,
  SQLiteAgentStore,
  SQLiteMemoryStore,
  SQLiteSessionStore,
  SQLiteSettingsStore,
  type AgentBuilder,
  type AgentEvent,
  type IModelProvider,
  type Message,
  type StreamEvent,
  type StreamOptions,
} from "@agent/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SubAgentDispatcher,
  type DynamicTeamRuntimeOptions,
} from "./sub-agent-dispatcher.js";

class TestModelProvider implements IModelProvider {
  readonly providerId = "test";
  readonly modelId = "test-model";
  readonly calls: Array<{ messages: Message[]; options?: StreamOptions }> = [];

  constructor(
    private readonly delayMs = 0,
    private readonly text = "child result",
  ) {}

  async *streamChat(messages: Message[], options?: StreamOptions): AsyncIterable<StreamEvent> {
    this.calls.push({ messages, options });
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    yield { type: "text_chunk", text: this.text };
    yield { type: "text_done" };
  }

  async countTokens(): Promise<number> { return 1; }
  supportsModel(): boolean { return true; }
}

interface FixtureOptions {
  maxWorkers?: number;
  maxParallel?: number;
  workerTimeoutMs?: number;
  provider?: IModelProvider;
  prepareBuilder?: DynamicTeamRuntimeOptions["prepareBuilder"];
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    getDatabase(root).close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentroam-sub-agent-dispatcher-"));
  roots.push(root);
  const agents = new SQLiteAgentStore(root);
  const sessions = new SQLiteSessionStore(root);
  const settings = new SQLiteSettingsStore(root);
  const memory = new SQLiteMemoryStore(root);
  const provider = options.provider ?? new TestModelProvider();
  const events: Array<{ event: AgentEvent; sessionId?: string }> = [];
  const registered: Array<{ sessionId: string; allowDispatch?: boolean }> = [];
  const capabilities: Array<{
    enabledTools: string[];
    enabledSkills: string[];
    enabledMCPServers: string[];
    memoryEnabled?: boolean;
  }> = [];
  const now = new Date().toISOString();
  await sessions.create({
    id: "parent-session",
    projectId: "",
    title: "Parent",
    status: "active",
    messages: [],
    events: [],
    created: now,
    updated: now,
    metadata: { permissionMode: "auto" },
  });
  settings.set("workingDirectory", root);

  const prepareBuilder = options.prepareBuilder ?? (async (builder: AgentBuilder, inherited) => {
    capabilities.push({
      enabledTools: [...inherited.enabledTools],
      enabledSkills: [...inherited.enabledSkills],
      enabledMCPServers: [...inherited.enabledMCPServers],
      memoryEnabled: inherited.memoryEnabled,
    });
    builder
      .withModelProvider(provider)
      .withExactEnabledTools(inherited.enabledTools)
      .withExactEnabledSkills(inherited.enabledSkills)
      .withSemanticSkillMatching(false)
      .withSkillDiscovery(false);
    return { applySkills: async () => {}, close: async () => {} };
  });

  const dispatcher = new SubAgentDispatcher(
    agents,
    sessions,
    settings,
    memory,
    (_builder, sessionId, allowDispatch) => {
      registered.push({ sessionId, allowDispatch });
    },
    (event, sessionId) => events.push({ event, sessionId }),
    undefined,
    {
      maxWorkers: options.maxWorkers ?? 3,
      maxParallel: options.maxParallel ?? 2,
      workerTimeoutMs: options.workerTimeoutMs ?? 1_000,
      runId: "flow-run-1",
      enabledTools: ["read_file", "spawn_agent", "dispatch_agent", "wait_agent"],
      enabledSkills: ["research"],
      enabledMCPServers: ["docs"],
      memoryEnabled: true,
      prepareBuilder,
    },
  );
  return { agents, sessions, dispatcher, events, registered, capabilities };
}

describe("SubAgentDispatcher dynamic team", () => {
  it("keeps temporary definitions ephemeral and retains completed results", async () => {
    const { agents, sessions, dispatcher, events, registered, capabilities } = await fixture();

    const started = await dispatcher.spawn({
      name: "Researcher",
      role: "Find primary evidence",
      task: "Inspect the protocol",
      instructions: "Cite exact behavior.",
    }, "parent-session");
    expect(started.status).toBe("running");
    expect(started.agentId).toBeTruthy();

    const completed = await dispatcher.wait(started.subSessionId);
    expect(completed).toMatchObject({
      status: "completed",
      agentName: "Researcher",
      subSessionId: started.subSessionId,
      agentId: started.agentId,
      summary: "child result",
    });
    expect(await dispatcher.wait(started.subSessionId)).toEqual(completed);
    expect(await agents.list()).toEqual([]);

    const child = await sessions.get(started.subSessionId);
    expect(child).toMatchObject({
      parentSessionId: "parent-session",
      status: "completed",
      metadata: {
        agentName: "Researcher",
        temporaryAgent: true,
        temporaryAgentId: started.agentId,
        dynamicTeamRunId: "flow-run-1",
        role: "Find primary evidence",
        task: "Inspect the protocol",
      },
    });
    expect(child?.messages[0]).toEqual({ role: "user", content: "Inspect the protocol" });
    expect(capabilities).toEqual([{
      enabledTools: ["read_file"],
      enabledSkills: ["research"],
      enabledMCPServers: ["docs"],
      memoryEnabled: true,
    }]);
    expect(registered).toEqual([{ sessionId: started.subSessionId, allowDispatch: false }]);

    const lifecycle = events.filter(({ event }) =>
      ["agent_dispatch", "agent_started", "agent_done"].includes(event.type));
    expect(lifecycle.map(({ event }) => event.type)).toEqual([
      "agent_dispatch",
      "agent_started",
      "agent_done",
    ]);
    for (const { event, sessionId } of lifecycle) {
      expect(sessionId).toBe("parent-session");
      expect(event).toMatchObject({
        agentName: "Researcher",
        agentId: started.agentId,
        subSessionId: started.subSessionId,
        parentSessionId: "parent-session",
      });
    }
  });

  it("enforces parallel and total worker limits", async () => {
    const provider = new TestModelProvider(40);
    const { dispatcher } = await fixture({
      provider,
      maxWorkers: 1,
      maxParallel: 1,
    });

    const first = await dispatcher.spawn({ name: "One", role: "r", task: "t" }, "parent-session");
    const parallelRejected = await dispatcher.spawn({ name: "Two", role: "r", task: "t" }, "parent-session");
    expect(parallelRejected).toMatchObject({ status: "failed", code: "MAX_WORKERS_EXCEEDED" });
    await dispatcher.wait(first.subSessionId);
    const totalRejected = await dispatcher.spawn({ name: "Three", role: "r", task: "t" }, "parent-session");
    expect(totalRejected).toMatchObject({ status: "failed", code: "MAX_WORKERS_EXCEEDED" });

    const parallelFixture = await fixture({ provider: new TestModelProvider(40), maxWorkers: 2, maxParallel: 1 });
    const active = await parallelFixture.dispatcher.spawn({ name: "One", role: "r", task: "t" }, "parent-session");
    const rejected = await parallelFixture.dispatcher.spawn({ name: "Two", role: "r", task: "t" }, "parent-session");
    expect(rejected).toMatchObject({ status: "failed", code: "MAX_PARALLEL_EXCEEDED" });
    await parallelFixture.dispatcher.wait(active.subSessionId);
  });

  it("turns worker timeouts and parent cancellation into retained failures", async () => {
    const timed = await fixture({ provider: new TestModelProvider(40), workerTimeoutMs: 5 });
    const started = await timed.dispatcher.spawn({ name: "Slow", role: "r", task: "t" }, "parent-session");
    await expect(timed.dispatcher.wait(started.subSessionId)).resolves.toMatchObject({
      status: "failed",
      code: "AGENT_TIMEOUT",
    });
    expect((await timed.sessions.get(started.subSessionId))?.status).toBe("failed");

    const cancelled = await fixture({ provider: new TestModelProvider(40) });
    const child = await cancelled.dispatcher.spawn({ name: "Cancelled", role: "r", task: "t" }, "parent-session");
    cancelled.dispatcher.abortAll();
    await expect(cancelled.dispatcher.wait(child.subSessionId)).resolves.toMatchObject({
      status: "failed",
      code: "PARENT_CANCELLED",
    });
  });

  it("clears the wait timeout when a child completes first", async () => {
    vi.useFakeTimers();
    try {
      const { dispatcher } = await fixture({ workerTimeoutMs: 10_000 });
      const started = await dispatcher.spawn({ name: "Fast", role: "r", task: "t" }, "parent-session");

      await expect(dispatcher.wait(started.subSessionId, 20_000)).resolves.toMatchObject({
        status: "completed",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the lifecycle when builder setup fails", async () => {
    const close = vi.fn(async () => {});
    const { dispatcher, sessions, events } = await fixture({
      prepareBuilder: async () => {
        throw Object.assign(new Error("builder exploded"), { code: "BUILDER_FAILED" });
      },
    });

    const started = await dispatcher.spawn({ name: "Broken", role: "r", task: "t" }, "parent-session");
    await expect(dispatcher.wait(started.subSessionId)).resolves.toMatchObject({
      status: "failed",
      code: "BUILDER_FAILED",
      error: "builder exploded",
    });
    expect((await sessions.get(started.subSessionId))?.status).toBe("failed");
    expect((await sessions.get("parent-session"))?.messages.at(-1)).toMatchObject({
      role: "user",
      name: "__mailbox__",
      content: expect.stringContaining("builder exploded"),
    });
    expect(events.find(({ event }) => event.type === "agent_done")?.event).toMatchObject({
      agentName: "Broken",
      agentId: started.agentId,
      subSessionId: started.subSessionId,
      parentSessionId: "parent-session",
      status: "failed",
      code: "BUILDER_FAILED",
      error: "builder exploded",
    });
    expect(close).not.toHaveBeenCalled();
  });
});
