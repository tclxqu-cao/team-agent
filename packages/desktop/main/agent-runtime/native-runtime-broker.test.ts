import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reduceRuntimeProgress, type AgentEvent } from "@agent/core";
import { encodeUnifiedSessionId } from "./session-id";
import {
  NativeRuntimeBrokerClient,
  NativeRuntimeBrokerHost,
} from "./native-runtime-broker";
import type {
  AgentRuntimeAdapter,
  AgentWorkspace,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  RuntimeRunOptions,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "./types";
import { RuntimeSessionError } from "./types";
import { UnifiedSessionService } from "./unified-session-service";

const sessionId = encodeUnifiedSessionId("codex", "thread-1");

function summary(
  occupancy: UnifiedSessionSummary["occupancy"] = "available",
  status: UnifiedSessionSummary["status"] = "idle",
): UnifiedSessionSummary {
  return {
    id: sessionId,
    agentType: "codex",
    nativeSessionId: "thread-1",
    title: "Native test",
    cwd: "/tmp/native-test",
    created: "2026-09-02T00:00:00.000Z",
    updated: "2026-09-02T00:00:00.000Z",
    status,
    occupancy,
    sourceLabel: "Test native runtime",
    canResume: occupancy !== "owned-externally",
    canDelete: false,
  };
}

class FakeNativeRuntime {
  private resolveRun: (() => void) | null = null;
  private adapterRunActive = false;
  readonly runOptions: RuntimeRunOptions[] = [];
  readonly answers: Array<{ questionId: string; answer: RuntimeQuestionAnswer }> = [];
  occupancy: UnifiedSessionSummary["occupancy"] = "available";
  status: UnifiedSessionSummary["status"] = "idle";
  runFailure: AgentEvent | null = null;
  answerResult = true;
  answerError: Error | null = null;
  completeOnAnswer = true;
  eventsBeforeApproval: AgentEvent[] = [];
  messages: UnifiedSessionDetail["messages"] = [];
  terminalEvent: Extract<AgentEvent, { type: "error" | "done" }> = { type: "done", finalText: "completed" };
  cleanupAfterTerminal: Promise<void> | null = null;
  rejectOverlappingRuns = false;
  listResult: UnifiedSessionSummary[] | null = null;
  createResult: UnifiedSessionSummary | null = null;
  readonly restoredDrafts: UnifiedSessionSummary[] = [];
  readonly invalidatedSessionIds: string[] = [];

  health = async (): Promise<RuntimeHealth[]> => [{ agentType: "codex", available: true, label: "Codex" }];
  list = async (): Promise<UnifiedSessionSummary[]> => this.listResult ?? [summary(this.occupancy, this.status)];
  refresh = this.list;
  create = async (): Promise<UnifiedSessionSummary> => this.createResult ?? summary();
  fork = async (): Promise<UnifiedSessionSummary> => summary();
  restoreDrafts = (drafts: UnifiedSessionSummary[]): void => {
    this.restoredDrafts.push(...drafts);
  };
  invalidate = (id: string): void => {
    this.invalidatedSessionIds.push(id);
  };
  getSessionWatchPath = async (): Promise<string | null> => null;
  steer = async (): Promise<boolean> => true;
  abort = async (): Promise<void> => { this.resolveRun?.(); };
  dispose = async (): Promise<void> => { this.resolveRun?.(); };
  get = async (): Promise<UnifiedSessionDetail> => ({
    ...summary(this.occupancy, this.status),
    messages: this.messages,
    events: [],
  });
  getUnpaginated = this.get;

  async *run(
    _id: string,
    _input: string,
    _images?: string[],
    _agentIds?: string[],
    _agentName?: string,
    options?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent> {
    if (this.rejectOverlappingRuns && this.adapterRunActive) {
      throw new RuntimeSessionError("Native adapter cleanup is still pending", "SESSION_OCCUPIED");
    }
    this.adapterRunActive = true;
    try {
      this.runOptions.push(options ?? {});
      if (this.runFailure) {
        yield this.runFailure;
        return;
      }
      for (const event of this.eventsBeforeApproval) yield event;
      const questionId = `native:${options?.brokerRunId}:approval-1`;
      yield {
        type: "ask_user",
        questionId,
        question: "Approve this native operation?",
        options: [{ label: "允许一次", description: "once" }],
      };
      await new Promise<void>((resolve) => { this.resolveRun = resolve; });
      yield this.terminalEvent;
    } finally {
      if (this.cleanupAfterTerminal) await this.cleanupAfterTerminal;
      this.adapterRunActive = false;
    }
  }

  answerQuestion = async (questionId: string, answer: RuntimeQuestionAnswer): Promise<boolean> => {
    this.answers.push({ questionId, answer });
    if (this.answerError) throw this.answerError;
    if (this.completeOnAnswer) this.resolveRun?.();
    return this.answerResult;
  };
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

const cleanup: string[] = [];

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentroam-native-broker-"));
  cleanup.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("NativeRuntimeBrokerHost", () => {
  it("persists imported workspaces and exposes same-Agent duplicates through the broker", async () => {
    const path = await directory();
    const runtimeFactory = (callbacks: import("./native-runtime-broker").NativeRuntimeBrokerCallbacks) => {
      const adapter: AgentRuntimeAdapter = {
        agentType: "codex",
        health: async () => ({ agentType: "codex", available: true, label: "Codex" }),
        discoverSessions: async () => [],
        listWorkspaces: async () => ({
          data: [{
            agentType: "codex",
            workspaceId: "native-project",
            name: "Native",
            roots: ["/native/repo"],
            order: 0,
            source: "native",
          } satisfies AgentWorkspace],
          nextCursor: null,
          watermark: "native",
        }),
        listWorkspaceSessions: async () => ({ data: [], nextCursor: null, watermark: null }),
        listWorkspaceSessionsByPath: async () => ({ data: [], nextCursor: null, watermark: null }),
        getSession: async () => { throw new Error("not used"); },
        create: async () => { throw new Error("not used"); },
        run: async function* () {},
        abort: async () => {},
        answerQuestion: async () => false,
      };
      return new UnifiedSessionService([adapter], async () => [], callbacks.importedWorkspaceRepository);
    };
    const firstHost = new NativeRuntimeBrokerHost(path, runtimeFactory);
    await firstHost.start();
    const firstClient = new NativeRuntimeBrokerClient({ directory: path });
    const created = await firstClient.importWorkspace("codex", "/manual/repo", "Manual");
    expect(created).toMatchObject({ existing: false, workspace: { source: "imported", name: "Manual" } });
    await firstHost.stop();

    const replacementHost = new NativeRuntimeBrokerHost(path, runtimeFactory);
    await replacementHost.start();
    const replacementClient = new NativeRuntimeBrokerClient({ directory: path });
    try {
      await expect(replacementClient.listWorkspaces("codex")).resolves.toMatchObject({
        data: [
          expect.objectContaining({ workspaceId: "native-project" }),
          expect.objectContaining({ workspaceId: created.workspace.workspaceId, source: "imported" }),
        ],
      });
      await expect(replacementClient.importWorkspace("codex", "/manual/repo/.", "Ignored"))
        .resolves.toMatchObject({ existing: true, workspace: { workspaceId: created.workspace.workspaceId } });
      await expect(replacementClient.importWorkspace("codex", "/native/repo"))
        .resolves.toMatchObject({ existing: true, workspace: { workspaceId: "native-project" } });
    } finally {
      await replacementHost.stop();
    }
  });

  it("keeps pending sessions scoped to their imported workspace path", async () => {
    const path = await directory();
    let sequence = 0;
    const runtimeFactory = (callbacks: import("./native-runtime-broker").NativeRuntimeBrokerCallbacks) => {
      const adapter: AgentRuntimeAdapter = {
        agentType: "codex",
        health: async () => ({ agentType: "codex", available: true, label: "Codex" }),
        discoverSessions: async () => [],
        listWorkspaces: async () => ({ data: [], nextCursor: null, watermark: null }),
        listWorkspaceSessions: async () => ({ data: [], nextCursor: null, watermark: null }),
        listWorkspaceSessionsByPath: async () => ({ data: [], nextCursor: null, watermark: null }),
        getSession: async () => { throw new Error("not used"); },
        create: async (options) => {
          sequence += 1;
          return {
            ...summary(),
            id: encodeUnifiedSessionId("codex", `pending-${sequence}`),
            nativeSessionId: `pending-${sequence}`,
            cwd: options.cwd,
            projectId: options.projectId,
          };
        },
        run: async function* () {},
        abort: async () => {},
        answerQuestion: async () => false,
      };
      return new UnifiedSessionService([adapter], async () => [], callbacks.importedWorkspaceRepository);
    };
    const host = new NativeRuntimeBrokerHost(path, runtimeFactory);
    await host.start();
    try {
      const first = await host.importWorkspace("codex", "/manual/first");
      const second = await host.importWorkspace("codex", "/manual/second");
      const firstSession = await host.create({ agentType: "codex", title: "First", cwd: "/manual/first" });
      await host.create({ agentType: "codex", title: "Second", cwd: "/manual/second" });

      await expect(host.listWorkspaceSessions("codex", first.workspace.workspaceId)).resolves.toMatchObject({
        data: [{ id: firstSession.id, cwd: "/manual/first" }],
      });
      await expect(host.listWorkspaceSessions("codex", second.workspace.workspaceId)).resolves.toMatchObject({
        data: [expect.objectContaining({ cwd: "/manual/second" })],
      });
    } finally {
      await host.stop();
    }
  });

  it.each([
    ["codex", "thread-title"],
    ["claude-code", "123e4567-e89b-42d3-a456-426614174099"],
    ["opencode", "session-title"],
  ] as const)("persists the first input title for a newly created %s session", async (agentType, nativeSessionId) => {
    const created: UnifiedSessionSummary = {
      ...summary(),
      id: encodeUnifiedSessionId(agentType, nativeSessionId),
      agentType,
      nativeSessionId,
      title: "新会话",
    };
    const runtime = new FakeNativeRuntime();
    runtime.createResult = created;
    runtime.listResult = [created];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await expect(host.create({ agentType, title: "新会话", cwd: created.cwd })).resolves.toMatchObject({
        title: "新会话",
      });
      await host.startRun(created.id, "第一条消息");
      await expect(host.list()).resolves.toEqual([
        expect.objectContaining({ id: created.id, title: "第一条消息" }),
      ]);
    } finally {
      await host.stop();
    }
  });

  it("keeps the auto title across broker replacement and does not overwrite it later", async () => {
    const path = await directory();
    const created = { ...summary(), title: "新会话" };
    const firstRuntime = new FakeNativeRuntime();
    firstRuntime.createResult = created;
    firstRuntime.listResult = [created];
    const firstHost = new NativeRuntimeBrokerHost(path, firstRuntime as unknown as UnifiedSessionService);
    await firstHost.create({ agentType: "codex", title: "新会话", cwd: created.cwd });
    await firstHost.startRun(created.id, "第一条消息");
    await waitFor(() => expect(firstHost.snapshot(created.id).events).toHaveLength(1));
    await firstHost.abort(created.id);
    await waitFor(() => expect(firstHost.snapshot(created.id).events.some(({ event }) => event.type === "done")).toBe(true));
    await firstHost.stop();

    const replacementRuntime = new FakeNativeRuntime();
    replacementRuntime.listResult = [created];
    const replacementHost = new NativeRuntimeBrokerHost(path, replacementRuntime as unknown as UnifiedSessionService);
    try {
      await expect(replacementHost.list()).resolves.toEqual([
        expect.objectContaining({ id: created.id, title: "第一条消息" }),
      ]);
      await replacementHost.startRun(created.id, "后续消息");
      await expect(replacementHost.list()).resolves.toEqual([
        expect.objectContaining({ id: created.id, title: "第一条消息" }),
      ]);
    } finally {
      await replacementHost.stop();
    }
  });

  it("does not rename an untracked historical placeholder session", async () => {
    const historical = { ...summary(), title: "新会话" };
    const runtime = new FakeNativeRuntime();
    runtime.listResult = [historical];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(historical.id, "历史会话消息");
      await expect(host.list()).resolves.toEqual([
        expect.objectContaining({ id: historical.id, title: "新会话" }),
      ]);
    } finally {
      await host.stop();
    }
  });

  it("keeps a new placeholder pending until the first non-empty input", async () => {
    const created = { ...summary(), title: "新会话" };
    const runtime = new FakeNativeRuntime();
    runtime.createResult = created;
    runtime.listResult = [created];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.create({ agentType: "codex", title: "新会话", cwd: created.cwd });
      await host.startRun(created.id, "   ");
      await waitFor(() => expect(host.snapshot(created.id).events).toHaveLength(1));
      await host.abort(created.id);
      await waitFor(() => expect(host.snapshot(created.id).events.some(({ event }) => event.type === "done")).toBe(true));

      await host.startRun(created.id, "first non-empty input");
      await expect(host.list()).resolves.toEqual([
        expect.objectContaining({ id: created.id, title: "first non-empty input" }),
      ]);
    } finally {
      await host.stop();
    }
  });

  it("restores a persisted empty Claude draft in a replacement broker", async () => {
    const path = await directory();
    const nativeSessionId = "123e4567-e89b-42d3-a456-426614174020";
    const draft: UnifiedSessionSummary = {
      ...summary(),
      id: encodeUnifiedSessionId("claude-code", nativeSessionId),
      agentType: "claude-code",
      nativeSessionId,
      title: "Persistent draft",
      cwd: "/repo/claude",
      sourceLabel: "Claude Code SDK",
    };
    const priorRuntime = new FakeNativeRuntime();
    priorRuntime.listResult = [];
    priorRuntime.createResult = draft;
    const priorHost = new NativeRuntimeBrokerHost(path, priorRuntime as unknown as UnifiedSessionService);
    await priorHost.create({ agentType: "claude-code", title: draft.title, cwd: draft.cwd });
    await priorHost.stop();

    const replacementRuntime = new FakeNativeRuntime();
    replacementRuntime.listResult = [];
    const replacementHost = new NativeRuntimeBrokerHost(path, replacementRuntime as unknown as UnifiedSessionService);
    try {
      expect(replacementRuntime.restoredDrafts).toEqual([draft]);
      await expect(replacementHost.list()).resolves.toEqual([
        expect.objectContaining({ id: draft.id, cwd: draft.cwd, title: draft.title }),
      ]);
    } finally {
      await replacementHost.stop();
    }
  });

  it("clears a persisted Claude draft after its first run completes", async () => {
    const path = await directory();
    const nativeSessionId = "123e4567-e89b-42d3-a456-426614174021";
    const draft: UnifiedSessionSummary = {
      ...summary(),
      id: encodeUnifiedSessionId("claude-code", nativeSessionId),
      agentType: "claude-code",
      nativeSessionId,
      title: "Materialized draft",
      cwd: "/repo/claude",
      sourceLabel: "Claude Code SDK",
    };
    const runtime = new FakeNativeRuntime();
    runtime.listResult = [];
    runtime.createResult = draft;
    const host = new NativeRuntimeBrokerHost(path, runtime as unknown as UnifiedSessionService);
    await host.create({ agentType: "claude-code", title: draft.title, cwd: draft.cwd });
    await host.startRun(draft.id, "materialize");
    await waitFor(() => expect(host.snapshot(draft.id).events).toHaveLength(1));
    await host.abort(draft.id);
    await waitFor(() => {
      expect(host.snapshot(draft.id).events.some(({ event }) => event.type === "done")).toBe(true);
    });
    await host.stop();

    const replacementRuntime = new FakeNativeRuntime();
    replacementRuntime.listResult = [];
    const replacementHost = new NativeRuntimeBrokerHost(path, replacementRuntime as unknown as UnifiedSessionService);
    try {
      expect(replacementRuntime.restoredDrafts).toEqual([]);
      await expect(replacementHost.list()).resolves.toEqual([]);
    } finally {
      await replacementHost.stop();
    }
  });

  it("persists hidden native sessions across broker replacement", async () => {
    const path = await directory();
    const runtime = new FakeNativeRuntime();
    runtime.listResult = [summary()];
    const host = new NativeRuntimeBrokerHost(path, runtime as unknown as UnifiedSessionService);
    try {
      await expect(host.list()).resolves.toEqual([
        expect.objectContaining({ id: sessionId, canDelete: true }),
      ]);

      await host.delete(sessionId);
      await expect(host.list()).resolves.toEqual([]);
      await expect(host.refresh()).resolves.toEqual([]);
      await expect(host.delete(sessionId)).resolves.toBeUndefined();
      expect(runtime.invalidatedSessionIds).toEqual([sessionId, sessionId]);
    } finally {
      await host.stop();
    }

    const replacementRuntime = new FakeNativeRuntime();
    replacementRuntime.listResult = [summary()];
    const replacementHost = new NativeRuntimeBrokerHost(
      path,
      replacementRuntime as unknown as UnifiedSessionService,
    );
    try {
      await expect(replacementHost.list()).resolves.toEqual([]);
    } finally {
      await replacementHost.stop();
    }
  });

  it("rejects stale access to a hidden native session", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(
      await directory(),
      runtime as unknown as UnifiedSessionService,
    );
    try {
      await host.delete(sessionId);

      await expect(host.get(sessionId)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      await expect(host.fork(sessionId)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      await expect(host.getSessionWatchPath(sessionId)).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      await expect(host.startRun(sessionId, "stale input")).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
      expect(runtime.runOptions).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  it("removes a hidden pending session from broker recovery", async () => {
    const path = await directory();
    const nativeSessionId = "123e4567-e89b-42d3-a456-426614174022";
    const draft: UnifiedSessionSummary = {
      ...summary(),
      id: encodeUnifiedSessionId("claude-code", nativeSessionId),
      agentType: "claude-code",
      nativeSessionId,
      title: "Hidden draft",
    };
    const runtime = new FakeNativeRuntime();
    runtime.listResult = [];
    runtime.createResult = draft;
    const host = new NativeRuntimeBrokerHost(path, runtime as unknown as UnifiedSessionService);
    await host.create({ agentType: "claude-code", title: draft.title, cwd: draft.cwd });
    await host.delete(draft.id);
    await host.stop();

    const replacementRuntime = new FakeNativeRuntime();
    replacementRuntime.listResult = [];
    const replacementHost = new NativeRuntimeBrokerHost(
      path,
      replacementRuntime as unknown as UnifiedSessionService,
    );
    try {
      expect(replacementRuntime.restoredDrafts).toEqual([]);
      await expect(replacementHost.list()).resolves.toEqual([]);
    } finally {
      await replacementHost.stop();
    }
  });

  it("rejects hiding a session while AgentRoam owns its active run", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "keep running");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));

      await expect(host.delete(sessionId)).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
      await expect(host.list()).resolves.toEqual([
        expect.objectContaining({ id: sessionId, canDelete: false }),
      ]);
    } finally {
      await host.abort(sessionId);
      await host.stop();
    }
  });

  it("persists one active goal, reorders the queue, and starts the next goal", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.enqueueGoal(sessionId, "first", "message-1", "desktop");
      await host.enqueueGoal(sessionId, "second", "message-2", "desktop");
      await host.enqueueGoal(sessionId, "third", "message-3", "desktop");
      const reordered = host.reorderGoals(sessionId, [
        (await host.getGoals(sessionId)).queued[1].id,
        (await host.getGoals(sessionId)).queued[0].id,
      ]);
      expect(reordered.active?.objective).toBe("first");
      expect(reordered.queued.map((goal) => goal.objective)).toEqual(["third", "second"]);
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      const question = host.snapshot(sessionId).events[0].event;
      await host.answerQuestion(question.type === "ask_user" ? question.questionId : "", { answer: "允许一次" });
      await waitFor(() => expect(runtime.runOptions).toHaveLength(2));
      expect(runtime.runOptions[0].goal).toMatchObject({ objective: "first" });
      expect(runtime.runOptions[1].goal).toMatchObject({ objective: "third" });
      expect((await host.getGoals(sessionId)).active?.objective).toBe("third");
    } finally {
      await host.stop();
    }
  });

  it("recovers a persisted active goal when a replacement broker starts", async () => {
    const path = await directory();
    const priorRuntime = new FakeNativeRuntime();
    const priorHost = new NativeRuntimeBrokerHost(path, priorRuntime as unknown as UnifiedSessionService);
    const replacementRuntime = new FakeNativeRuntime();
    const replacementHost = new NativeRuntimeBrokerHost(path, replacementRuntime as unknown as UnifiedSessionService);
    try {
      await priorHost.enqueueGoal(sessionId, "survive restart", "message-restart", "desktop");
      await waitFor(() => expect(priorRuntime.runOptions).toHaveLength(1));

      await replacementHost.start();

      await waitFor(() => expect(replacementRuntime.runOptions).toHaveLength(1));
      expect(replacementRuntime.runOptions[0].goal).toMatchObject({ objective: "survive restart" });
      expect((await replacementHost.getGoals(sessionId, "desktop")).active?.objective).toBe("survive restart");
    } finally {
      await priorHost.stop();
      await replacementHost.stop();
    }
  });

  it("replays native subagent activity snapshots without changing nested messages", async () => {
    const runtime = new FakeNativeRuntime();
    const activity = {
      taskId: "task-1",
      parentToolCallId: "agent-tool",
      agentName: "Explore",
      description: "Inspect",
      status: "running" as const,
      messages: [
        { role: "assistant" as const, content: "Reading", toolCalls: [{ id: "read-1", name: "Read", arguments: {} }] },
        { role: "tool" as const, content: "source", toolCallId: "read-1" },
      ],
    };
    runtime.eventsBeforeApproval = [{ type: "native_subagent_update", activity }];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "delegate");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(2));

      expect(host.snapshot(sessionId).events[0].event).toEqual({
        type: "native_subagent_update",
        activity,
      });
    } finally {
      await host.stop();
    }
  });

  it("projects reasoning summaries while keeping runtime progress event-only", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.eventsBeforeApproval = [
      { type: "reasoning_summary_delta", itemId: "reasoning-1", sectionIndex: 0, delta: "Inspect " },
      { type: "reasoning_summary_delta", itemId: "reasoning-1", sectionIndex: 0, delta: "files" },
      { type: "runtime_progress", progressId: "thinking", phase: "thinking", label: "正在思考" },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "inspect");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(4));

      const detail = await host.get(sessionId);
      expect(detail.messages.flatMap((message) => message.presentation?.reasoning ?? [])).toEqual([
        { itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" },
      ]);
      expect(detail.messages.some((message) => message.content.includes("正在思考"))).toBe(false);
      expect(reduceRuntimeProgress(detail.events)).toEqual([
        { progressId: "thinking", phase: "thinking", label: "正在思考" },
      ]);

      const question = detail.events.find((event) => event.type === "ask_user");
      await host.answerQuestion(question?.type === "ask_user" ? question.questionId : "", { answer: "允许一次" });
      await waitFor(() => expect(host.snapshot(sessionId).events.some(({ event }) => event.type === "done")).toBe(true));
      expect(reduceRuntimeProgress((await host.get(sessionId)).events)).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  it("does not duplicate a retained reasoning delta after native history catches up", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.messages = [{
      role: "assistant",
      content: "",
      presentation: {
        reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" }],
      },
    }];
    runtime.eventsBeforeApproval = [
      { type: "reasoning_summary_delta", itemId: "reasoning-1", sectionIndex: 0, delta: "Inspect files" },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "inspect");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(2));
      const reasoning = (await host.get(sessionId)).messages.flatMap(
        (message) => message.presentation?.reasoning ?? [],
      );
      expect(reasoning).toEqual([
        { itemId: "reasoning-1", sectionIndex: 0, text: "Inspect files" },
      ]);
    } finally {
      await host.stop();
    }
  });

  it("deduplicates retained text and tools across split native assistant items", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.messages = [
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "shell", arguments: {} }] },
      { role: "assistant", content: "Done" },
    ];
    runtime.eventsBeforeApproval = [
      { type: "tool_call", toolCall: { id: "call-1", name: "shell", arguments: {} } },
      { type: "text_chunk", text: "Done" },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "run");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(3));
      const assistants = (await host.get(sessionId)).messages.filter((message) => message.role === "assistant");
      expect(assistants).toHaveLength(2);
      expect(assistants.filter((message) => message.content === "Done")).toHaveLength(1);
      expect(assistants.flatMap((message) => message.toolCalls ?? []).filter((tool) => tool.id === "call-1")).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  it("deduplicates retained text aggregated across consecutive native assistant messages", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.messages = [
      { role: "user", content: "run" },
      { role: "assistant", content: "First update. " },
      { role: "assistant", content: "Second update." },
    ];
    runtime.eventsBeforeApproval = [
      { type: "text_chunk", text: "First update. " },
      { type: "text_chunk", text: "Second update." },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "run");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(3));

      const assistants = (await host.get(sessionId)).messages.filter((message) => message.role === "assistant");
      expect(assistants.map((message) => message.content)).toEqual([
        "First update. ",
        "Second update.",
      ]);
    } finally {
      await host.stop();
    }
  });

  it("keeps the unpersisted suffix of retained text after a split native prefix", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.messages = [
      { role: "user", content: "run" },
      { role: "assistant", content: "First update. " },
      { role: "assistant", content: "Second update." },
    ];
    runtime.eventsBeforeApproval = [
      { type: "text_chunk", text: "First update. " },
      { type: "text_chunk", text: "Second update." },
      { type: "text_chunk", text: " Still live." },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "run");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(4));

      const assistants = (await host.get(sessionId)).messages.filter((message) => message.role === "assistant");
      expect(assistants.map((message) => message.content)).toEqual([
        "First update. ",
        "Second update.",
        " Still live.",
      ]);
    } finally {
      await host.stop();
    }
  });

  it("deduplicates a retained run after a later user message reaches native history", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.messages = [
      { role: "user", content: "run" },
      { role: "assistant", content: "First update. " },
      { role: "assistant", content: "Second update." },
      { role: "user", content: "later input" },
    ];
    runtime.eventsBeforeApproval = [
      { type: "text_chunk", text: "First update. " },
      { type: "text_chunk", text: "Second update." },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "run");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(3));

      const detail = await host.get(sessionId);
      expect(detail.messages.filter((message) => message.role === "user")).toEqual(runtime.messages.filter(
        (message) => message.role === "user",
      ));
      expect(detail.messages.filter((message) => message.role === "assistant").map(
        (message) => message.content,
      )).toEqual(["First update. ", "Second update."]);
    } finally {
      await host.stop();
    }
  });

  it("deduplicates the active projection before splitting native history into pages", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.messages = [
      { role: "user", content: "long-running goal" },
      { role: "assistant", content: "First update. " },
      { role: "assistant", content: "Second update." },
    ];
    runtime.eventsBeforeApproval = [
      { type: "text_chunk", text: "First update. " },
      { type: "text_chunk", text: "Second update." },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "long-running goal");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(3));

      const latest = await host.get(sessionId, { limit: 2 });
      const oldest = await host.get(sessionId, { before: latest.history?.nextCursor ?? undefined, limit: 2 });
      const combined = [...oldest.messages, ...latest.messages];

      expect(combined.filter((message) => message.role === "user")).toEqual([
        { role: "user", content: "long-running goal" },
      ]);
      expect(combined.filter((message) => message.name?.startsWith("__native_run:"))).toEqual([]);
      expect(combined.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual([
        "First update. ",
        "Second update.",
      ]);
    } finally {
      await host.stop();
    }
  });

  it("defaults policy to full access, snapshots a pending approval, and claims it once", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      expect(host.setPermissionMode(sessionId, "full-access").permissionMode).toBe("full-access");
      const started = await host.startRun(sessionId, "make a change");
      await waitFor(() => {
        expect(host.snapshot(sessionId).events).toHaveLength(1);
      });

      const snapshot = host.snapshot(sessionId);
      const question = snapshot.events[0].event;
      expect(question).toMatchObject({ type: "ask_user", questionId: `native:${started.runId}:approval-1` });
      expect(runtime.runOptions[0]?.permissionMode).toBe("full-access");

      await expect(host.answerQuestion(question.type === "ask_user" ? question.questionId : "", { answer: "允许一次" })).resolves.toBe(true);
      await expect(host.answerQuestion(question.type === "ask_user" ? question.questionId : "", { answer: "允许一次" })).resolves.toBe(false);
      await waitFor(() => {
        expect(host.snapshot(sessionId).events.some(({ event }) => event.type === "done")).toBe(true);
      });
      expect(runtime.answers).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  it("rejects duplicate admission without replacing the first live projection", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      const first = await host.startRun(sessionId, "first input");
      await waitFor(() => expect(host.snapshot(sessionId).runId).toBe(first.runId));

      await expect(host.startRun(sessionId, "second input")).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
      const detail = await host.get(sessionId);
      expect(detail.messages.some((message) => message.role === "user" && message.content === "first input")).toBe(true);
      expect(detail.messages.some((message) => message.content === "second input")).toBe(false);
    } finally {
      await host.stop();
    }
  });

  it("waits for interrupted adapter cleanup before admitting the next run", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.rejectOverlappingRuns = true;
    runtime.terminalEvent = {
      type: "error",
      code: "NATIVE_PROTOCOL_ERROR",
      message: "Codex turn was interrupted.",
    };
    let releaseCleanup: () => void = () => undefined;
    runtime.cleanupAfterTerminal = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "first input");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      await host.abort(sessionId);
      await waitFor(() => {
        expect(host.snapshot(sessionId).events).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: expect.objectContaining({ type: "error" }) }),
        ]));
      });

      let secondSettled = false;
      const second = host.startRun(sessionId, "second input").then((started) => {
        secondSettled = true;
        return started;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(secondSettled).toBe(false);
      expect(runtime.runOptions).toHaveLength(1);

      releaseCleanup();
      await expect(second).resolves.toMatchObject({ runId: expect.any(String) });
      await waitFor(() => expect(runtime.runOptions).toHaveLength(2));
      await expect(host.get(sessionId)).resolves.toMatchObject({
        occupancy: "owned-by-customer-agent",
        canResume: true,
      });
    } finally {
      releaseCleanup();
      await host.stop();
    }
  });

  it("persists a policy change for the next run without changing an admitted run snapshot", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      host.setPermissionMode(sessionId, "auto-approval");
      await host.startRun(sessionId, "first policy snapshot");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      expect(runtime.runOptions[0]?.permissionMode).toBe("auto-approval");

      host.setPermissionMode(sessionId, "full-access");
      const question = host.snapshot(sessionId).events[0].event;
      if (question.type !== "ask_user") throw new Error("Expected approval request");
      await host.answerQuestion(question.questionId, { answer: "允许一次" });
      await waitFor(() => expect(host.snapshot(sessionId).events.some(({ event }) => event.type === "done")).toBe(true));

      await host.startRun(sessionId, "second policy snapshot");
      await waitFor(() => expect(runtime.runOptions).toHaveLength(2));
      expect(runtime.runOptions[1]?.permissionMode).toBe("full-access");
    } finally {
      await host.stop();
    }
  });

  it("interrupts only the affected run when its claimed approval has expired", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.answerResult = false;
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "requires approval");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      const question = host.snapshot(sessionId).events[0].event;
      expect(question.type).toBe("ask_user");
      if (question.type !== "ask_user") throw new Error("Expected approval request");

      await expect(host.answerQuestion(question.questionId, { answer: "允许一次" })).rejects.toMatchObject({
        code: "APPROVAL_EXPIRED",
      });
      await waitFor(() => {
        expect(host.snapshot(sessionId).events).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: expect.objectContaining({ type: "error", code: "APPROVAL_EXPIRED" }) }),
        ]));
      });
      expect(host.snapshot(sessionId).events.some(({ event }) => event.type === "ask_user")).toBe(false);
      expect((await host.get(sessionId)).occupancy).toBe("available");
    } finally {
      await host.stop();
    }
  });

  it("retains a confirmed external owner when an adapter emits an occupied terminal error", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.runFailure = {
      type: "error",
      code: "SESSION_OCCUPIED",
      message: "Codex session is open in another client",
    };
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "resume");
      await waitFor(() => {
        expect(host.snapshot(sessionId).events).toEqual(expect.arrayContaining([
          expect.objectContaining({ event: expect.objectContaining({ code: "SESSION_OCCUPIED" }) }),
        ]));
      });

      const [summary] = await host.list();
      expect(summary).toMatchObject({
        occupancy: "owned-externally",
        canResume: false,
      });
    } finally {
      await host.stop();
    }
  });

  it("resets a subscriber cursor when the same session starts a later run", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      const first = await host.startRun(sessionId, "first");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      const initial = host.snapshot(sessionId);
      const received: Array<{ runId: string; sequence: number; event: AgentEvent }> = [];
      const unsubscribe = host.subscribe(sessionId, initial.snapshotRevision, (event) => received.push(event));
      const question = initial.events[0].event;
      if (question.type !== "ask_user") throw new Error("Expected approval request");

      await host.answerQuestion(question.questionId, { answer: "允许一次" });
      await waitFor(() => expect(host.snapshot(sessionId).events.some(({ event }) => event.type === "done")).toBe(true));
      const second = await host.startRun(sessionId, "second");
      await waitFor(() => {
        expect(received).toEqual(expect.arrayContaining([
          expect.objectContaining({
            runId: second.runId,
            sequence: 1,
            event: expect.objectContaining({ type: "ask_user" }),
          }),
        ]));
      });
      expect(received.some((event) => event.runId === first.runId && event.sequence > initial.snapshotRevision)).toBe(true);
      unsubscribe();
    } finally {
      await host.stop();
    }
  });

  it("converts stale active rows to a terminal interruption after a new host owns the socket", async () => {
    const path = await directory();
    const firstRuntime = new FakeNativeRuntime();
    const priorHost = new NativeRuntimeBrokerHost(path, firstRuntime as unknown as UnifiedSessionService);
    const replacementRuntime = new FakeNativeRuntime();
    const replacementHost = new NativeRuntimeBrokerHost(path, replacementRuntime as unknown as UnifiedSessionService);
    try {
      await priorHost.startRun(sessionId, "before restart");
      await waitFor(() => expect(priorHost.snapshot(sessionId).events).toHaveLength(1));

      await replacementHost.start();
      const snapshot = replacementHost.snapshot(sessionId);
      expect(snapshot.events).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: expect.objectContaining({ type: "error", code: "NATIVE_PROTOCOL_ERROR" }) }),
      ]));
      await expect(replacementHost.startRun(sessionId, "after restart")).resolves.toMatchObject({ runId: expect.any(String) });
    } finally {
      await priorHost.stop();
      await replacementHost.stop();
    }
  });

  it("uses one socket host for a second client instead of starting another runtime", async () => {
    const runtime = new FakeNativeRuntime();
    const path = await directory();
    const host = new NativeRuntimeBrokerHost(path, runtime as unknown as UnifiedSessionService);
    await host.start();
    try {
      const client = new NativeRuntimeBrokerClient({ directory: path });
      await expect(client.setPermissionMode(sessionId, "auto-approval")).resolves.toMatchObject({ permissionMode: "auto-approval" });
      await expect(client.startRun(sessionId, "socket input")).resolves.toMatchObject({ permissionMode: "auto-approval" });
      await waitFor(() => expect(runtime.runOptions).toHaveLength(1));
      await expect(client.startRun(sessionId, "duplicate")).rejects.toMatchObject({ code: "SESSION_OCCUPIED" });
      expect(runtime.runOptions).toHaveLength(1);
    } finally {
      await host.stop();
    }
  });

  it("preserves adapter execution status while a different client owns the writer lock", async () => {
    let now = 1_000;
    const runtime = new FakeNativeRuntime();
    runtime.occupancy = "owned-externally";
    const host = new NativeRuntimeBrokerHost(
      await directory(),
      runtime as unknown as UnifiedSessionService,
      () => now,
    );
    try {
      await host.list();
      now += 5_000;
      await expect(host.list()).resolves.toEqual([
        expect.objectContaining({ occupancy: "owned-externally", status: "idle", canResume: false }),
      ]);

      runtime.status = "running";
      await expect(host.get(sessionId)).resolves.toMatchObject({
        occupancy: "owned-externally",
        status: "running",
        canResume: false,
      });
    } finally {
      await host.stop();
    }
  });

  it("projects an admitted broker run as running independently from adapter occupancy", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await expect(host.get(sessionId)).resolves.toMatchObject({
        occupancy: "available",
        status: "idle",
      });

      await host.startRun(sessionId, "run through broker");
      await waitFor(() => expect(runtime.runOptions).toHaveLength(1));
      await expect(host.get(sessionId)).resolves.toMatchObject({
        occupancy: "owned-by-customer-agent",
        status: "running",
        controller: "web",
      });
    } finally {
      await host.stop();
    }
  });

  it("does not flicker an external lock until two debounced observations agree", async () => {
    let now = 1_000;
    const runtime = new FakeNativeRuntime();
    runtime.occupancy = "owned-externally";
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService, () => now);
    try {
      expect((await host.list())[0].occupancy).toBe("available");
      now += 5_000;
      expect((await host.list())[0].occupancy).toBe("owned-externally");
      runtime.occupancy = "available";
      now += 1_000;
      expect((await host.list())[0].occupancy).toBe("owned-externally");
      now += 5_000;
      expect((await host.list())[0].occupancy).toBe("available");
    } finally {
      await host.stop();
    }
  });
});
