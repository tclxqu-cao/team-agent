import { beforeEach, describe, expect, it, vi } from "vitest";
import { TodoError } from "@agent/core";
import { encodeUnifiedSessionId, RuntimeSessionError, type AgentType, type AgentWorkspace, type CreateRuntimeSessionOptions, type RuntimeHealth, type RuntimeTodoContext, type UnifiedSessionSummary, type WorkspacePage } from "@agent/native-runtime";
import type { NativeRuntimePort } from "./native-runtime-service";
import { NativeRuntimeService, normalizeProjectPath } from "./native-runtime-service";

const todoMocks = vi.hoisted(() => ({ create: vi.fn(), stored: vi.fn(), warn: vi.fn() }));
vi.mock("./todo/runtime-todo-context", () => ({
  createRuntimeTodoContext: todoMocks.create,
  storedRuntimeTodoContext: todoMocks.stored,
}));
vi.mock("./global-logger", () => ({ serverLogger: () => ({ warn: todoMocks.warn }) }));

function summary(
  id: string,
  updated = "2026-08-31T00:00:00.000Z",
  cwd = "/tmp",
): UnifiedSessionSummary {
  return {
    id,
    agentType: "codex",
    nativeSessionId: id,
    title: "新会话",
    cwd,
    created: updated,
    updated,
    status: "idle",
    occupancy: "available",
    sourceLabel: "Codex",
    canResume: true,
    canDelete: false,
  };
}

class FakeRuntime implements NativeRuntimePort {
  discovered: UnifiedSessionSummary[] = [];
  createResult: UnifiedSessionSummary | null = null;
  forkResult: UnifiedSessionSummary | null = null;
  getError: unknown = null;
  listCalls: Array<string | undefined> = [];
  refreshCalls: Array<string | undefined> = [];
  deletedIds: string[] = [];
  releasedIds: string[] = [];
  workspaceSessions: UnifiedSessionSummary[] = [];
  createCalls: Array<CreateRuntimeSessionOptions & { agentType: AgentType }> = [];

  health = async (): Promise<RuntimeHealth[]> => [];
  listModels = async () => [];
  listWorkspaces = async (agentType: Exclude<AgentType, "customer-agent">): Promise<WorkspacePage<AgentWorkspace>> => ({
    data: [{ agentType, workspaceId: "workspace", name: "Workspace", roots: ["/tmp"], order: 0, source: "native" }],
    nextCursor: null,
    watermark: null,
  });
  listWorkspaceSessions = async (): Promise<WorkspacePage<UnifiedSessionSummary>> => ({
    data: this.workspaceSessions,
    nextCursor: null,
    watermark: null,
  });
  list = async (projectId?: string): Promise<UnifiedSessionSummary[]> => {
    this.listCalls.push(projectId);
    return projectId === undefined
      ? this.discovered
      : this.discovered.filter((session) => session.projectId === projectId);
  };
  refresh = async (projectId?: string): Promise<UnifiedSessionSummary[]> => {
    this.refreshCalls.push(projectId);
    return projectId === undefined
      ? this.discovered
      : this.discovered.filter((session) => session.projectId === projectId);
  };
  create = async (options: CreateRuntimeSessionOptions & { agentType: AgentType }): Promise<UnifiedSessionSummary> => {
    this.createCalls.push(options);
    if (!this.createResult) throw new Error("no create result configured");
    return this.createResult;
  };
  fork = async (): Promise<UnifiedSessionSummary> => {
    if (!this.forkResult) throw new Error("no fork result configured");
    return this.forkResult;
  };
  delete = async (id: string): Promise<void> => {
    this.deletedIds.push(id);
  };
  get = async (id: string) => {
    if (this.getError) throw this.getError;
    const found = this.discovered.find((s) => s.id === id);
    if (!found) throw new Error(`session not found: ${id}`);
    return { ...found, messages: [], events: [] };
  };
  getSessionWatchPath = async (id: string): Promise<string | null> => `/tmp/${id}.jsonl`;
  getSessionToolResult = async (
    _id: string,
    ref: { turnId: string; itemId: string; revision: string },
  ) => ({ ...ref, byteSize: 6, content: "output" });
  steer = async (): Promise<boolean> => false;
  run = async function* (): AsyncGenerator<never> {};
  abort = async (): Promise<void> => {};
  release = async (id: string): Promise<void> => { this.releasedIds.push(id); };
  answerQuestion = async (): Promise<boolean> => false;
}

describe("native Todo binding compatibility", () => {
  const context: RuntimeTodoContext = {
    serviceId: "fixture-service", ownerId: "fixture-owner",
    descriptorPath: "/fixture/private/manage.json", relayPath: "/fixture/private/relay.json",
  };
  const contexts = new Map<string, RuntimeTodoContext>();
  const missingBinding = () => new RuntimeSessionError("Unsupported broker method: bindTodoContext", "OPERATION_NOT_SUPPORTED");
  const operations = ["create", "start", "enqueue"] as const;

  beforeEach(() => {
    contexts.clear();
    todoMocks.create.mockReset().mockReturnValue(context);
    todoMocks.stored.mockReset().mockImplementation((id: string, seed?: RuntimeTodoContext) => {
      const stored = contexts.get(id) ?? seed ?? context;
      contexts.set(id, stored);
      return stored;
    });
    todoMocks.warn.mockReset();
  });

  function fixture(agentType: "codex" | "zcode" = "codex") {
    const id = encodeUnifiedSessionId(agentType, "binding-fixture");
    const runtime = Object.assign(new FakeRuntime(), {
      bindTodoContext: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn().mockResolvedValue({ runId: "fixture-run", snapshotRevision: 0 }),
      enqueueMessage: vi.fn().mockResolvedValue({ state: { active: null, queued: [], history: [] } }),
    });
    runtime.createResult = { ...summary(id), agentType };
    const service = new NativeRuntimeService(runtime);
    const invoke = (operation: typeof operations[number], seed?: RuntimeTodoContext) => operation === "create"
      ? service.create({ agentType, cwd: "/fixture", title: "Fixture chat", ...(seed ? { todoContext: seed } : {}) })
      : operation === "start" ? service.startRun(id, "Fixture input")
        : service.enqueueMessage(id, { sourceMessageId: "fixture-message", content: "Fixture input" });
    return { id, runtime, service, invoke };
  }

  it.each(["codex", "zcode"] as const)("keeps interactive %s create, send and queue usable with the exact legacy missing method", async agentType => {
    const { id, runtime, invoke } = fixture(agentType);
    runtime.bindTodoContext.mockRejectedValue(missingBinding());

    for (const operation of operations) await expect(invoke(operation)).resolves.toBeDefined();

    expect(runtime.createCalls[0].todoContext).toBe(context);
    expect(runtime.bindTodoContext.mock.calls).toEqual([[id, context], [id, context], [id, context]]);
    expect(runtime.startRun).toHaveBeenCalledWith(id, "Fixture input", undefined, "web", undefined);
    expect(runtime.enqueueMessage).toHaveBeenCalledWith(id, { sourceMessageId: "fixture-message", content: "Fixture input" }, "web");
    expect(contexts.get(id)).toBe(context);
    expect(todoMocks.warn).toHaveBeenCalledTimes(3);
    expect(todoMocks.warn).toHaveBeenCalledWith(expect.stringContaining("without Todo integration"), {
      sessionId: id, method: "bindTodoContext", code: "OPERATION_NOT_SUPPORTED",
    });
  });

  it.each(operations)("preserves successful %s binding and credentials on a current broker", async operation => {
    const { id, runtime, invoke } = fixture();
    await invoke(operation, context);

    expect(runtime.bindTodoContext).toHaveBeenCalledWith(id, context);
    expect(contexts.get(id)).toBe(context);
    expect(todoMocks.warn).not.toHaveBeenCalled();
  });

  it("binds Todo for the next message after the shared broker is replaced", async () => {
    const { id, runtime, invoke } = fixture();
    runtime.bindTodoContext.mockRejectedValueOnce(missingBinding());

    await invoke("start");
    await invoke("start");

    expect(runtime.bindTodoContext.mock.calls).toEqual([[id, context], [id, context]]);
    expect(runtime.startRun).toHaveBeenCalledTimes(2);
    expect(todoMocks.warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    new RuntimeSessionError("Unsupported broker method: startRun", "OPERATION_NOT_SUPPORTED"),
    new RuntimeSessionError("Unsupported broker method: bindTodoContext", "RUNTIME_UNAVAILABLE"),
    new Error("Unsupported broker method: bindTodoContext"),
    new TodoError("FORBIDDEN", "Todo credential identity mismatch"),
  ])("propagates every nonmatching binding failure: %s", async error => {
    for (const operation of operations) {
      const { runtime, invoke } = fixture();
      runtime.bindTodoContext.mockRejectedValue(error);
      await expect(invoke(operation)).rejects.toBe(error);
      expect(runtime.startRun).not.toHaveBeenCalled();
      expect(runtime.enqueueMessage).not.toHaveBeenCalled();
    }
    expect(todoMocks.warn).not.toHaveBeenCalled();
  });

  it("never treats credential validation as a missing broker capability", async () => {
    const { runtime, invoke } = fixture();
    const error = new TodoError("FORBIDDEN", "Todo session belongs to another service");
    todoMocks.stored.mockImplementation(() => { throw error; });
    runtime.bindTodoContext.mockRejectedValue(missingBinding());

    for (const operation of operations) await expect(invoke(operation)).rejects.toBe(error);
    expect(runtime.bindTodoContext).not.toHaveBeenCalled();
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(runtime.enqueueMessage).not.toHaveBeenCalled();
    expect(todoMocks.warn).not.toHaveBeenCalled();
  });

  it.each(operations)("fails closed for execution-scoped %s even when only the legacy method is missing", async operation => {
    const { id, runtime, invoke } = fixture("zcode");
    const execution = { ...context, executionId: "fixture-execution" };
    contexts.set(id, execution);
    const error = missingBinding();
    runtime.bindTodoContext.mockRejectedValue(error);

    await expect(invoke(operation, execution)).rejects.toBe(error);
    expect(runtime.bindTodoContext).toHaveBeenCalledWith(id, execution);
    expect(runtime.startRun).not.toHaveBeenCalled();
    expect(runtime.enqueueMessage).not.toHaveBeenCalled();
    expect(todoMocks.warn).not.toHaveBeenCalled();
  });

  it("retains a failed scheduled creation's execution scope across enqueue retries", async () => {
    const { id, runtime, invoke } = fixture("zcode");
    const execution = { ...context, executionId: "fixture-execution" };
    const error = missingBinding();
    runtime.bindTodoContext.mockRejectedValue(error);

    await expect(invoke("create", execution)).rejects.toBe(error);
    await expect(invoke("enqueue")).rejects.toBe(error);
    await expect(invoke("enqueue")).rejects.toBe(error);
    expect(runtime.bindTodoContext.mock.calls).toEqual([[id, execution], [id, execution], [id, execution]]);
    expect(contexts.get(id)).toBe(execution);
    expect(runtime.enqueueMessage).not.toHaveBeenCalled();
    expect(todoMocks.warn).not.toHaveBeenCalled();
  });

  it("does not reuse an interactive fallback for a later execution binding", async () => {
    const { id, runtime, invoke } = fixture();
    const error = missingBinding();
    runtime.bindTodoContext.mockRejectedValue(error);
    await expect(invoke("start")).resolves.toBeDefined();
    const execution = { ...context, executionId: "fixture-execution" };
    contexts.set(id, execution);

    await expect(invoke("enqueue")).rejects.toBe(error);
    expect(runtime.bindTodoContext).toHaveBeenLastCalledWith(id, execution);
    expect(runtime.enqueueMessage).not.toHaveBeenCalled();
    expect(todoMocks.warn).toHaveBeenCalledTimes(1);
  });
});

describe("NativeRuntimeService", () => {
  it("creates a Codex session by cwd while retaining the selected local project's association", async () => {
    const projectId = "747702c4-acaf-44ea-ac57-73dc77eb79ee";
    const cwd = "/Users/caoqu/refund";
    const runtime = new FakeRuntime();
    runtime.createResult = summary("message-session", undefined, cwd);
    const service = new NativeRuntimeService(runtime, async () => [{ id: projectId, name: "refund", description: cwd }]);
    const created = await service.create({ agentType: "codex", projectId, cwd, title: "[消息] 兼容性和风险都看" });
    expect(runtime.createCalls).toEqual([{ agentType: "codex", cwd, title: "[消息] 兼容性和风险都看" }]);
    expect(created.projectId).toBe(projectId);
    expect((await service.list(projectId)).map(session => session.id)).toContain(created.id);
  });

  it("preserves actual native project IDs when they do not identify a local project", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("native-project-session");
    const service = new NativeRuntimeService(runtime);
    await service.create({ agentType: "codex", projectId: "native-project", cwd: "/tmp", title: "native" });
    expect(runtime.createCalls[0].projectId).toBe("native-project");
  });

  it("forwards an explicit Codex release to the native broker", async () => {
    const runtime = new FakeRuntime();
    const service = new NativeRuntimeService(runtime);

    await service.release("runtime:codex:dGhyZWFkLTE");

    expect(runtime.releasedIds).toEqual(["runtime:codex:dGhyZWFkLTE"]);
  });

  it("keeps transcript watch paths internal while forwarding their lookup", async () => {
    const service = new NativeRuntimeService(new FakeRuntime());

    await expect(service.getSessionWatchPath("native-session")).resolves.toBe(
      "/tmp/native-session.jsonl",
    );
  });

  it("keeps created sessions visible until the runtime discovers them", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [summary("old", "2026-08-30T00:00:00.000Z")];
    runtime.createResult = summary("fresh", "2026-08-31T12:00:00.000Z");
    const service = new NativeRuntimeService(runtime);

    const created = await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });
    const listed = await service.list();

    expect(created.id).toBe("fresh");
    expect(listed.map((s) => s.id)).toEqual(["fresh", "old"]);
  });

  it("preserves authoritative discovery order when timestamps imply another order", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [
      summary("recency-first", "2026-08-31T00:00:01.000Z"),
      summary("recency-second", "2026-08-31T00:00:03.000Z"),
    ];
    const service = new NativeRuntimeService(runtime);

    const listed = await service.list();

    expect(listed.map((session) => session.id)).toEqual(["recency-first", "recency-second"]);
  });

  it("keeps a pending native session in its stable workspace page", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh", "2026-08-31T12:00:00.000Z", "/repo");
    const service = new NativeRuntimeService(runtime);

    await service.create({
      agentType: "codex",
      title: "新会话",
      cwd: "/repo",
      projectId: "codex-project",
    });

    await expect(service.listWorkspaceSessions("codex", "codex-project")).resolves.toMatchObject({
      data: [expect.objectContaining({ id: "fresh", projectId: "codex-project" })],
    });
  });

  it("drops pending entries once discovery returns them", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh");
    const service = new NativeRuntimeService(runtime);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });

    runtime.discovered = [summary("fresh", "2026-08-31T12:05:00.000Z")];
    const listed = await service.refresh();

    expect(listed.map((s) => s.id)).toEqual(["fresh"]);
    expect(listed[0].updated).toBe("2026-08-31T12:05:00.000Z");
  });

  it("keeps pending project context when discovery returns the same session without cwd", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh", "2026-08-31T12:00:00.000Z", "/repo/app");
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "app", description: "/repo/app" },
    ]);
    const created = await service.create({ agentType: "claude-code", title: "新会话", cwd: "/repo/app" });
    runtime.discovered = [{ ...created, cwd: "", projectId: undefined }];

    await expect(service.refresh("app")).resolves.toEqual([
      expect.objectContaining({ id: "fresh", cwd: "/repo/app", projectId: "app" }),
    ]);
  });

  it("keeps forked sessions visible until the runtime discovers them", async () => {
    const runtime = new FakeRuntime();
    const sourceId = encodeUnifiedSessionId("codex", "source");
    runtime.forkResult = {
      ...summary(encodeUnifiedSessionId("codex", "fork"), "2026-08-31T12:00:00.000Z"),
      nativeSessionId: "fork",
    };
    const service = new NativeRuntimeService(runtime);

    const forked = await service.fork(sourceId);
    const listed = await service.list();

    expect(forked.id).toBe(runtime.forkResult.id);
    expect(listed.map((session) => session.id)).toEqual([runtime.forkResult.id]);
  });

  it("delegates deletion and removes a pending session projection", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh");
    const service = new NativeRuntimeService(runtime);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });

    await service.delete("fresh");

    expect(runtime.deletedIds).toEqual(["fresh"]);
    await expect(service.list()).resolves.toEqual([]);
  });

  it("rejects Customer Agent session forks", async () => {
    const service = new NativeRuntimeService(new FakeRuntime());

    await expect(service.fork("ca-session")).rejects.toMatchObject({
      code: "OPERATION_NOT_SUPPORTED",
    });
  });

  it("uses the local project catalog before applying a project-scoped filter", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [summary("scoped", undefined, "/repo/app/packages/server")];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "root", description: "/repo" },
      { id: "app", description: "/repo/app" },
    ]);

    await expect(service.list("app")).resolves.toEqual([
      expect.objectContaining({ id: "scoped", projectId: "app" }),
    ]);
    expect(runtime.listCalls).toEqual([undefined]);
  });

  it("replaces foreign project IDs and excludes nonmatching local projects", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [{
      ...summary("foreign", undefined, "/repo/app"),
      projectId: "project-from-another-client",
    }];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "local-app", description: "/repo/app" },
      { id: "local-other", description: "/repo/other" },
    ]);

    await expect(service.list("local-app")).resolves.toEqual([
      expect.objectContaining({ id: "foreign", projectId: "local-app" }),
    ]);
    await expect(service.list("local-other")).resolves.toEqual([]);
  });

  it("associates Windows sessions across drive-letter and directory casing", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [summary("windows", undefined, "d:\\REPO\\packages\\app")];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "repo", description: "D:\\repo" },
    ], "win32");

    await expect(service.list("repo")).resolves.toEqual([
      expect.objectContaining({ id: "windows", projectId: "repo" }),
    ]);
  });

  it("keeps Windows project matching boundary-safe and selects the longest root", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [
      summary("nested", undefined, "D:\\repo\\app\\src"),
      summary("prefix-only", undefined, "D:\\repo-old\\src"),
    ];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "root", description: "D:\\repo" },
      { id: "app", description: "d:\\REPO\\app\\" },
    ], "win32");

    expect(await service.list("app")).toEqual([
      expect.objectContaining({ id: "nested", projectId: "app" }),
    ]);
    expect((await service.list()).find((session) => session.id === "prefix-only")?.projectId)
      .toBeUndefined();
  });

  it("keeps POSIX project matching case-sensitive", () => {
    expect(normalizeProjectPath("/Repo/App", "darwin"))
      .not.toBe(normalizeProjectPath("/repo/app", "darwin"));
  });

  it("keeps locally projected pending sessions visible in project-scoped listings", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh", "2026-08-31T12:00:00.000Z", "/repo/app");
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "app", description: "/repo/app" },
    ]);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/repo/app" });

    expect((await service.list("app")).map((session) => session.id)).toEqual(["fresh"]);

    runtime.discovered = [summary("fresh", "2026-08-31T12:05:00.000Z", "/repo/app")];
    const refreshed = await service.refresh("app");
    expect(refreshed.map((session) => session.id)).toEqual(["fresh"]);
    expect(refreshed[0].updated).toBe("2026-08-31T12:05:00.000Z");
    expect(runtime.refreshCalls).toEqual([undefined]);
  });

  it("serves detail from the pending registry when lookup fails", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh");
    const service = new NativeRuntimeService(runtime);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });

    const detail = await service.get("fresh");
    expect(detail.id).toBe("fresh");
    expect(detail.messages).toEqual([]);
  });

  it("propagates lookup errors for sessions it never created", async () => {
    const runtime = new FakeRuntime();
    const service = new NativeRuntimeService(runtime);
    await expect(service.get("unknown")).rejects.toThrow("session not found");
  });
});
