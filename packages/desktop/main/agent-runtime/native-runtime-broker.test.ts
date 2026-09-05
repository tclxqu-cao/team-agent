import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { reduceRuntimeProgress, type AgentEvent } from "@agent/core";
import { encodeUnifiedSessionId } from "./session-id";
import type { CodexDiskSessionCatalogEntry, CodexSessionCatalogRepository } from "./codex-session-disk-catalog";
import {
  NativeRuntimeBrokerClient,
  NativeRuntimeBrokerHost,
} from "./native-runtime-broker";
import type {
  AgentRuntimeAdapter,
  AgentType,
  AgentWorkspace,
  RuntimeHealth,
  RuntimeQuestionAnswer,
  RuntimeRunOptions,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
  WorkspacePage,
  WorkspaceSessionQuery,
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
  readonly runInputs: Array<{
    input: string;
    images?: string[];
    agentIds?: string[];
    agentName?: string;
  }> = [];
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
  readonly archivedSessionIds: string[] = [];
  readonly invalidatedSessionIds: string[] = [];
  archiveError: Error | null = null;
  readonly workspaceSessionQueries: WorkspaceSessionQuery[] = [];
  workspaceSessions: UnifiedSessionSummary[] = [];
  steerResult = true;
  readonly steeredInputs: Array<{ id: string; input: string }> = [];
  readonly getUnpaginatedCachePreferences: boolean[] = [];

  health = async (): Promise<RuntimeHealth[]> => [{ agentType: "codex", available: true, label: "Codex" }];
  list = async (): Promise<UnifiedSessionSummary[]> => this.listResult ?? [summary(this.occupancy, this.status)];
  refresh = this.list;
  listWorkspaceSessions = async (
    _agentType: AgentType,
    _workspaceId: string,
    query: WorkspaceSessionQuery = {},
  ): Promise<WorkspacePage<UnifiedSessionSummary>> => {
    this.workspaceSessionQueries.push(query);
    const offset = Number(query.cursor ?? 0);
    const limit = query.limit ?? 50;
    const data = this.workspaceSessions.slice(offset, offset + limit);
    const nextOffset = offset + data.length;
    return {
      data,
      nextCursor: nextOffset < this.workspaceSessions.length ? String(nextOffset) : null,
      watermark: this.workspaceSessions[0]?.updated ?? null,
    };
  };
  create = async (): Promise<UnifiedSessionSummary> => this.createResult ?? summary();
  fork = async (): Promise<UnifiedSessionSummary> => summary();
  restoreDrafts = (drafts: UnifiedSessionSummary[]): void => {
    this.restoredDrafts.push(...drafts);
  };
  invalidate = (id: string): void => {
    this.invalidatedSessionIds.push(id);
  };
  archive = async (id: string): Promise<void> => {
    this.archivedSessionIds.push(id);
    if (this.archiveError) throw this.archiveError;
  };
  getSessionWatchPath = async (): Promise<string | null> => null;
  steer = async (id: string, input: string): Promise<boolean> => {
    this.steeredInputs.push({ id, input });
    return this.steerResult;
  };
  abort = async (): Promise<void> => { this.resolveRun?.(); };
  dispose = async (): Promise<void> => { this.resolveRun?.(); };
  get = async (): Promise<UnifiedSessionDetail> => ({
    ...summary(this.occupancy, this.status),
    messages: this.messages,
    events: [],
  });
  getUnpaginated = async (_id: string, preferCache = false): Promise<UnifiedSessionDetail> => {
    this.getUnpaginatedCachePreferences.push(preferCache);
    return this.get();
  };

  async *run(
    _id: string,
    input: string,
    images?: string[],
    agentIds?: string[],
    agentName?: string,
    options?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent> {
    if (this.rejectOverlappingRuns && this.adapterRunActive) {
      throw new RuntimeSessionError("Native adapter cleanup is still pending", "SESSION_ALREADY_RUNNING");
    }
    this.adapterRunActive = true;
    try {
      this.runOptions.push(options ?? {});
      this.runInputs.push({ input, images, agentIds, agentName });
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
  it("keeps completed-turn duration after broker restart and event pruning", async () => {
    const path = await directory();
    let now = 1_000;
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(path, runtime as unknown as UnifiedSessionService, () => now);
    await host.startRun(sessionId, "measure");
    await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
    const question = host.snapshot(sessionId).events[0].event;
    now = 4_500;
    await host.answerQuestion(question.type === "ask_user" ? question.questionId : "", { answer: "允许一次" });
    await waitFor(() => expect(host.snapshot(sessionId).events.some(({ event }) => event.type === "done")).toBe(true));
    runtime.messages = [
      { role: "user", content: "measure" },
      { role: "assistant", content: "completed" },
    ];
    expect(host.snapshot(sessionId).events.find(({ event }) => event.type === "done")?.event).toMatchObject({
      type: "done",
      durationMs: 3_500,
    });
    await expect(host.get(sessionId)).resolves.toMatchObject({
      messages: [
        { role: "user", content: "measure" },
        { role: "assistant", content: "completed", presentation: { completionDurationMs: 3_500 } },
      ],
    });
    await host.stop();

    now += 10 * 60 * 1_000 + 1;
    const replacementRuntime = new FakeNativeRuntime();
    replacementRuntime.messages = runtime.messages;
    const replacementHost = new NativeRuntimeBrokerHost(
      path,
      replacementRuntime as unknown as UnifiedSessionService,
      () => now,
    );
    try {
      await replacementHost.start();
      expect(replacementHost.snapshot(sessionId).events).toEqual([]);
      await expect(replacementHost.get(sessionId)).resolves.toMatchObject({
        messages: [
          { role: "user", content: "measure" },
          { role: "assistant", content: "completed", presentation: { completionDurationMs: 3_500 } },
        ],
      });
    } finally {
      await replacementHost.stop();
    }
  });

  it("omits duration when identical native turns make attribution ambiguous", async () => {
    let now = 1_000;
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(
      await directory(),
      runtime as unknown as UnifiedSessionService,
      () => now,
    );
    try {
      await host.startRun(sessionId, "repeat");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      const question = host.snapshot(sessionId).events[0].event;
      now = 2_000;
      await host.answerQuestion(question.type === "ask_user" ? question.questionId : "", { answer: "允许一次" });
      await waitFor(() => expect(host.snapshot(sessionId).events.some(({ event }) => event.type === "done")).toBe(true));
      runtime.messages = [
        { role: "user", content: "repeat" },
        { role: "assistant", content: "completed" },
        { role: "user", content: "repeat" },
        { role: "assistant", content: "completed" },
      ];

      const detail = await host.get(sessionId);
      expect(detail.messages.filter((message) => message.role === "assistant")).toEqual([
        { role: "assistant", content: "completed" },
        { role: "assistant", content: "completed" },
      ]);
    } finally {
      await host.stop();
    }
  });

  it("persists the Codex compatibility catalog in broker-owned SQLite", async () => {
    const path = await directory();
    let firstRepository!: CodexSessionCatalogRepository;
    const firstHost = new NativeRuntimeBrokerHost(path, (callbacks) => {
      firstRepository = callbacks.codexSessionCatalogRepository;
      return new UnifiedSessionService([], async () => []);
    });
    const cachedEntry: CodexDiskSessionCatalogEntry = {
      canonicalPath: "/sessions/legacy.jsonl",
      size: 100,
      mtimeNs: "123",
      nativeSessionId: "019f0000-0000-7000-8000-000000000301",
      probeable: true,
      producerVersion: "0.122.0",
      cwd: "/repo",
      created: "2026-09-04T00:00:00.000Z",
      updated: "2026-09-04T00:00:00.000Z",
      formatKey: "meta-v1:test",
      compatibility: { status: "checking", producerVersion: "0.122.0", readerVersion: "0.153.0" },
    };
    firstRepository.replace([cachedEntry], {
      schemaVersion: 1,
      registryVersion: 1,
      readerVersion: "0.153.0",
    });
    await firstHost.stop();

    let replacementRepository!: CodexSessionCatalogRepository;
    const replacementHost = new NativeRuntimeBrokerHost(path, (callbacks) => {
      replacementRepository = callbacks.codexSessionCatalogRepository;
      return new UnifiedSessionService([], async () => []);
    });
    try {
      expect(replacementRepository.load({
        schemaVersion: 1,
        registryVersion: 1,
        readerVersion: "0.153.0",
      })).toEqual([cachedEntry]);
    } finally {
      await replacementHost.stop();
    }
  });

  it("replaces a previous Codex reader snapshot without path conflicts", async () => {
    const path = await directory();
    let repository!: CodexSessionCatalogRepository;
    const host = new NativeRuntimeBrokerHost(path, (callbacks) => {
      repository = callbacks.codexSessionCatalogRepository;
      return new UnifiedSessionService([], async () => []);
    });
    const cachedEntry: CodexDiskSessionCatalogEntry = {
      canonicalPath: "/sessions/shared.jsonl",
      size: 100,
      mtimeNs: "123",
      nativeSessionId: "019f0000-0000-7000-8000-000000000302",
      probeable: true,
      producerVersion: "0.140.0",
      cwd: "/repo",
      created: "2026-09-04T00:00:00.000Z",
      updated: "2026-09-04T00:00:00.000Z",
      compatibility: { status: "checking", producerVersion: "0.140.0", readerVersion: "0.152.0" },
    };

    try {
      repository.replace([cachedEntry], {
        schemaVersion: 1,
        registryVersion: 1,
        readerVersion: "0.152.0",
      });
      repository.replace([{
        ...cachedEntry,
        compatibility: { status: "checking", producerVersion: "0.140.0", readerVersion: "0.153.0" },
      }], {
        schemaVersion: 1,
        registryVersion: 1,
        readerVersion: "0.153.0",
      });

      expect(repository.load({
        schemaVersion: 1,
        registryVersion: 1,
        readerVersion: "0.152.0",
      })).toEqual([]);
      expect(repository.load({
        schemaVersion: 1,
        registryVersion: 1,
        readerVersion: "0.153.0",
      })).toEqual([expect.objectContaining({
        canonicalPath: cachedEntry.canonicalPath,
        compatibility: expect.objectContaining({ readerVersion: "0.153.0" }),
      })]);
    } finally {
      await host.stop();
    }
  });

  it("fills workspace pages past hidden sessions without skipping later sessions", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.workspaceSessions = Array.from({ length: 50 }, (_, index) => {
      const nativeSessionId = `thread-${index}`;
      return {
        ...summary(),
        id: encodeUnifiedSessionId("codex", nativeSessionId),
        nativeSessionId,
        projectId: "workspace",
        title: `Session ${index}`,
        updated: new Date(Date.UTC(2026, 8, 4, 0, 0, 50 - index)).toISOString(),
      };
    });
    const host = new NativeRuntimeBrokerHost(
      await directory(),
      runtime as unknown as UnifiedSessionService,
    );
    try {
      for (const session of runtime.workspaceSessions.slice(0, 20)) await host.delete(session.id);

      const first = await host.listWorkspaceSessions("codex", "workspace", { limit: 20 });
      expect(first.data).toHaveLength(20);
      expect(first.data[0]?.nativeSessionId).toBe("thread-20");
      expect(first.nextCursor).toBe("40");
      expect(runtime.workspaceSessionQueries.slice(0, 2)).toEqual([
        expect.objectContaining({ cursor: null, limit: 20, refresh: false }),
        expect.objectContaining({ cursor: "20", limit: 20, refresh: false }),
      ]);

      const second = await host.listWorkspaceSessions("codex", "workspace", {
        cursor: first.nextCursor,
        limit: 20,
      });
      expect(second.data).toHaveLength(10);
      expect(second.data[0]?.nativeSessionId).toBe("thread-40");
      expect(second.nextCursor).toBeNull();
    } finally {
      await host.stop();
    }
  });

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
          expect.objectContaining({ workspaceId: "codex:recent", canCreateSession: false }),
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

  it("keeps a new Codex session writable while the disk catalog reports it as checking", async () => {
    const created = { ...summary(), projectId: "workspace", title: "新会话" };
    const supplemental = {
      ...created,
      compatibility: { status: "checking" as const, readerVersion: "0.153.0" },
      canResume: false,
    };
    const runtime = new FakeNativeRuntime();
    runtime.createResult = created;
    runtime.workspaceSessions = [supplemental];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.create({ agentType: "codex", title: created.title, cwd: created.cwd, projectId: "workspace" });

      const pendingPage = await host.listWorkspaceSessions("codex", "workspace");
      expect(pendingPage).toMatchObject({
        data: [{ id: created.id, canResume: true }],
      });
      expect(pendingPage.data[0]).not.toHaveProperty("compatibility");

      runtime.workspaceSessions = [created];
      await host.listWorkspaceSessions("codex", "workspace");
      runtime.workspaceSessions = [supplemental];

      await expect(host.listWorkspaceSessions("codex", "workspace")).resolves.toMatchObject({
        data: [{ id: created.id, compatibility: supplemental.compatibility, canResume: false }],
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
      expect(runtime.archivedSessionIds).toEqual([sessionId]);
      expect(runtime.invalidatedSessionIds).toEqual([sessionId]);
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

  it("keeps a Codex session visible when native archive fails and allows retry", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.listResult = [summary()];
    runtime.archiveError = new Error("archive failed");
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await expect(host.delete(sessionId)).rejects.toThrow("archive failed");
      await expect(host.list()).resolves.toEqual([
        expect.objectContaining({ id: sessionId }),
      ]);
      expect(runtime.invalidatedSessionIds).toEqual([]);

      runtime.archiveError = null;
      await expect(host.delete(sessionId)).resolves.toBeUndefined();
      await expect(host.list()).resolves.toEqual([]);
      expect(runtime.archivedSessionIds).toEqual([sessionId, sessionId]);
      expect(runtime.invalidatedSessionIds).toEqual([sessionId]);
    } finally {
      await host.stop();
    }
  });

  it("keeps Claude Code and OpenCode deletion tombstone-only", async () => {
    const runtime = new FakeNativeRuntime();
    const claudeId = encodeUnifiedSessionId("claude-code", "claude-1");
    const opencodeId = encodeUnifiedSessionId("opencode", "opencode-1");
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.delete(claudeId);
      await host.delete(opencodeId);

      expect(runtime.archivedSessionIds).toEqual([]);
      expect(runtime.invalidatedSessionIds).toEqual([claudeId, opencodeId]);
    } finally {
      await host.stop();
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
      expect(runtime.archivedSessionIds).toEqual([]);
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

  it("persists ordinary queued messages and starts them without goal semantics", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "current");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));

      const queued = await host.enqueueMessage(sessionId, {
        sourceMessageId: "chat-message-1",
        content: "follow up",
        messagePayload: {
          images: ["data:image/png;base64,AAAA"],
          agentIds: ["reviewer"],
          agentName: "Reviewer",
        },
      });
      expect(queued.started).toBeUndefined();
      expect(queued.state.queued).toEqual([
        expect.objectContaining({
          kind: "message",
          objective: "follow up",
          sourceMessageId: "chat-message-1",
        }),
      ]);
      await expect(host.get(sessionId)).resolves.toMatchObject({
        goalState: {
          queued: [expect.objectContaining({ kind: "message", objective: "follow up" })],
        },
      });

      const firstQuestion = host.snapshot(sessionId).events[0].event;
      await host.answerQuestion(
        firstQuestion.type === "ask_user" ? firstQuestion.questionId : "",
        { answer: "允许一次" },
      );
      await waitFor(() => expect(runtime.runInputs).toHaveLength(2));
      expect(runtime.runInputs[1]).toEqual({
        input: "follow up",
        images: ["data:image/png;base64,AAAA"],
        agentIds: ["reviewer"],
        agentName: "Reviewer",
      });
      expect(runtime.runOptions[1].goal).toBeUndefined();
      expect((await host.getGoals(sessionId)).active).toMatchObject({ kind: "message" });
    } finally {
      await host.stop();
    }
  });

  it("steers a persisted queued message and removes it only after the runtime accepts it", async () => {
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "current");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      const queued = await host.enqueueMessage(sessionId, {
        sourceMessageId: "chat-steer",
        content: "use this now",
      });
      const queueItemId = queued.state.queued[0].id;

      await expect(host.steerMessage(sessionId, queueItemId)).resolves.toEqual({
        steered: true,
        state: expect.objectContaining({ queued: [] }),
      });
      expect(runtime.steeredInputs).toEqual([{ id: sessionId, input: "use this now" }]);
      expect((await host.getGoals(sessionId)).queued).toEqual([]);
    } finally {
      await host.stop();
    }
  });

  it("keeps a persisted queued message when the runtime rejects steering", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.steerResult = false;
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "current");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(1));
      const queued = await host.enqueueMessage(sessionId, {
        sourceMessageId: "chat-steer-rejected",
        content: "keep queued",
      });
      const queueItemId = queued.state.queued[0].id;

      await expect(host.steerMessage(sessionId, queueItemId)).resolves.toMatchObject({
        steered: false,
        state: { queued: [expect.objectContaining({ id: queueItemId })] },
      });
      expect((await host.getGoals(sessionId)).queued).toEqual([
        expect.objectContaining({ id: queueItemId, objective: "keep queued" }),
      ]);
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

  it("resumes an unclaimed queued message after broker restart", async () => {
    const path = await directory();
    const priorRuntime = new FakeNativeRuntime();
    const priorHost = new NativeRuntimeBrokerHost(path, priorRuntime as unknown as UnifiedSessionService);
    const replacementRuntime = new FakeNativeRuntime();
    const replacementHost = new NativeRuntimeBrokerHost(path, replacementRuntime as unknown as UnifiedSessionService);
    try {
      await priorHost.startRun(sessionId, "interrupted current run");
      await waitFor(() => expect(priorRuntime.runInputs).toHaveLength(1));
      await priorHost.enqueueMessage(sessionId, {
        sourceMessageId: "chat-restart",
        content: "survive restart",
      });

      await replacementHost.start();

      await waitFor(() => expect(replacementRuntime.runInputs).toHaveLength(1));
      expect(replacementRuntime.runInputs[0].input).toBe("survive restart");
      expect(replacementRuntime.runOptions[0].goal).toBeUndefined();
    } finally {
      await priorHost.stop();
      await replacementHost.stop();
    }
  });

  it("does not replay a queued message that was already admitted before restart", async () => {
    const path = await directory();
    const priorRuntime = new FakeNativeRuntime();
    const priorHost = new NativeRuntimeBrokerHost(path, priorRuntime as unknown as UnifiedSessionService);
    const replacementRuntime = new FakeNativeRuntime();
    const replacementHost = new NativeRuntimeBrokerHost(path, replacementRuntime as unknown as UnifiedSessionService);
    try {
      await priorHost.enqueueMessage(sessionId, {
        sourceMessageId: "chat-admitted",
        content: "do not replay",
      });
      await waitFor(() => expect(priorRuntime.runInputs).toHaveLength(1));

      await replacementHost.start();

      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(replacementRuntime.runInputs).toHaveLength(0);
      expect(await replacementHost.getGoals(sessionId)).toEqual({ active: null, queued: [], history: [] });
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

  it("refreshes latest pages while reusing the warmed detail for index and cursor reads", async () => {
    const runtime = new FakeNativeRuntime();
    runtime.messages = [
      { role: "user", content: "older" },
      { role: "assistant", content: "older answer" },
      { role: "user", content: "latest" },
      { role: "assistant", content: "latest answer" },
    ];
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      const latest = await host.get(sessionId, { limit: 2 });
      await host.getQueryIndex(sessionId);
      await host.get(sessionId, { limit: 2 });
      await host.get(sessionId, {
        before: latest.history?.olderCursor ?? undefined,
        limit: 2,
      });

      expect(runtime.getUnpaginatedCachePreferences).toEqual([false, true, false, true]);
    } finally {
      await host.stop();
    }
  });

  it("deduplicates the active projection before splitting native history into pages", async () => {
    const runtime = new FakeNativeRuntime();
    const turnResponses = [
      ...Array.from({ length: 53 }, (_, index) => `Update ${index + 1}`),
      "Final response",
    ];
    runtime.messages = [
      { role: "user", content: "older input" },
      { role: "assistant", content: "Older response" },
      { role: "user", content: "long-running goal" },
      ...turnResponses.map((content) => ({
        role: "assistant" as const,
        content,
      })),
    ];
    runtime.eventsBeforeApproval = turnResponses.map((text) => ({ type: "text_chunk" as const, text }));
    const host = new NativeRuntimeBrokerHost(await directory(), runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "long-running goal");
      await waitFor(() => expect(host.snapshot(sessionId).events).toHaveLength(55));

      const latest = await host.get(sessionId, { limit: 50 });
      const oldest = await host.get(sessionId, { before: latest.history?.nextCursor ?? undefined, limit: 50 });
      const combined = [...oldest.messages, ...latest.messages];

      expect(latest.messages[0]).toMatchObject({ role: "user", content: "long-running goal" });
      expect(latest.history).toMatchObject({ nextCursor: "history.v1.2", pageSize: 55 });
      expect(oldest.messages.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "older input" },
        { role: "assistant", content: "Older response" },
      ]);
      expect(combined.filter((message) => message.role === "user").map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "older input" },
        { role: "user", content: "long-running goal" },
      ]);
      expect(combined.filter((message) => message.name?.startsWith("__native_run:"))).toEqual([]);
      expect(combined.filter((message) => message.role === "assistant" && message.content === "Final response")).toHaveLength(1);
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

      await expect(host.startRun(sessionId, "second input")).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
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

  it("promotes a queued message after interrupted adapter cleanup", async () => {
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

      let enqueueSettled = false;
      const queued = host.enqueueMessage(sessionId, {
        sourceMessageId: "chat-after-interrupt",
        content: "queued after interrupt",
      }).then((result) => {
        enqueueSettled = true;
        return result;
      });
      await expect(host.get(sessionId)).resolves.toMatchObject({
        goalState: {
          active: expect.objectContaining({
            kind: "message",
            objective: "queued after interrupt",
          }),
        },
      });

      let goalsSettled = false;
      const goals = host.getGoals(sessionId).then((state) => {
        goalsSettled = true;
        return state;
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(enqueueSettled).toBe(false);
      expect(goalsSettled).toBe(false);
      expect(runtime.runInputs).toHaveLength(1);

      releaseCleanup();
      await expect(queued).resolves.toMatchObject({
        state: {
          active: expect.objectContaining({ kind: "message", objective: "queued after interrupt" }),
          queued: [],
        },
      });
      await expect(goals).resolves.toMatchObject({
        active: expect.objectContaining({ kind: "message", objective: "queued after interrupt" }),
        queued: [],
      });
      await waitFor(() => expect(runtime.runInputs).toHaveLength(2));
      expect(runtime.runInputs[1].input).toBe("queued after interrupt");
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(runtime.runInputs).toHaveLength(2);
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
      await expect(client.startRun(sessionId, "duplicate")).rejects.toMatchObject({ code: "SESSION_ALREADY_RUNNING" });
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

describe("NativeRuntimeBrokerHost run overrides", () => {
  it("passes composer model/effort choices through to the adapter run options", async () => {
    const path = await directory();
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(path, runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "hi", undefined, "web", undefined, undefined, undefined, {
        model: { id: "gpt-5.6-sol", providerID: "openai" },
        reasoningEffort: "xhigh",
      });
      await waitFor(() => expect(runtime.runOptions).toHaveLength(1));
      expect(runtime.runOptions[0]).toMatchObject({
        model: { id: "gpt-5.6-sol", providerID: "openai" },
        reasoningEffort: "xhigh",
      });
    } finally {
      await host.stop();
    }
  });

  it("keeps adapter options untouched when the run carries no overrides", async () => {
    const path = await directory();
    const runtime = new FakeNativeRuntime();
    const host = new NativeRuntimeBrokerHost(path, runtime as unknown as UnifiedSessionService);
    try {
      await host.startRun(sessionId, "hi");
      await waitFor(() => expect(runtime.runOptions).toHaveLength(1));
      expect(runtime.runOptions[0].model).toBeUndefined();
      expect(runtime.runOptions[0].reasoningEffort).toBeUndefined();
    } finally {
      await host.stop();
    }
  });
});
