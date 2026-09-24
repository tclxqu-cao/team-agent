import { afterEach, describe, expect, it, vi } from "vitest";
import * as filesystem from "node:fs/promises";
import { appendFile, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodexRuntimeAdapter,
  codexProgressNotificationToEvent,
  codexReasoningNotificationToEvent,
  codexThreadStatusToSessionStatus,
  codexTurnPermissionOptions,
  codexTurnsToMessages,
  normalizeCodexUserText,
  parseExplicitSkillInvocation,
  resolveCodexHome,
} from "./codex-runtime-adapter.js";
import { CodexRolloutCommentaryReader } from "./codex-rollout-activity.js";
import { RuntimeSessionError } from "./types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe("Codex explicit skills", () => {
  it("maps slash skills to native names while reserving built-in commands", () => {
    expect(parseExplicitSkillInvocation("/frontend-design build it")).toEqual({
      name: "frontend-design",
      rest: "build it",
    });
    expect(parseExplicitSkillInvocation("/goal finish it")).toBeNull();
    expect(parseExplicitSkillInvocation("plain text")).toBeNull();
  });
});

const temporaryDirectories: string[] = [];

describe("Codex session status mapping", () => {
  it("keeps execution status independent from writer-lock ownership", () => {
    expect(codexThreadStatusToSessionStatus("idle")).toBe("idle");
    expect(codexThreadStatusToSessionStatus("notLoaded")).toBe("idle");
    expect(codexThreadStatusToSessionStatus("unknown-state")).toBe("idle");
    expect(codexThreadStatusToSessionStatus("active")).toBe("running");
    expect(codexThreadStatusToSessionStatus("systemError")).toBe("failed");
    expect(codexThreadStatusToSessionStatus("idle", true)).toBe("running");
    expect(codexThreadStatusToSessionStatus("idle", false, true)).toBe("running");
    expect(codexThreadStatusToSessionStatus("idle", false, false)).toBe("idle");
  });
});

describe("Codex home and Windows occupancy", () => {
  it("honors CODEX_HOME and falls back to the user home", () => {
    expect(resolveCodexHome({ CODEX_HOME: " /custom/codex " }, "/users/test"))
      .toBe("/custom/codex");
    expect(resolveCodexHome({}, "/users/test")).toBe("/users/test/.codex");
  });

  it("reports launcher setup failures without falling back to another Codex", async () => {
    const request = vi.fn();
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request,
      } as never,
      environment: { AGENT_CODEX_RUNTIME_ERROR: "managed Codex download failed" },
    });

    await expect(adapter.health()).resolves.toMatchObject({
      available: false,
      error: "managed Codex download failed",
    });
    await expect(adapter.discoverSessions()).rejects.toMatchObject({
      code: "RUNTIME_UNAVAILABLE",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { activity: "running" as const, occupancy: "owned-externally", status: "running", canResume: false },
    { activity: "idle" as const, occupancy: "available", status: "idle", canResume: true },
  ])("projects a Windows $activity rollout without lsof as $occupancy", async (expected) => {
    const path = "D:\\project\\.codex\\rollout.jsonl";
    const thread = {
      id: `cx-${expected.activity}`,
      parentThreadId: null,
      preview: "Windows Desktop session",
      name: null,
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path,
      cwd: "D:\\project",
      source: "desktop",
      turns: [],
    };
    const request = vi.fn(async (method: string) => {
      if (method === "thread/list") return { data: [thread], nextCursor: null };
      throw new Error(`unexpected request: ${method}`);
    });
    const client = {
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request,
      restart: async () => undefined,
      dispose: async () => undefined,
    };
    const readMany = vi.fn(async (paths: Iterable<string>) => {
      expect([...paths]).toEqual([path]);
      return new Map([[path, expected.activity]]);
    });
    const adapter = new CodexRuntimeAdapter({
      client: client as never,
      discoveryClient: client as never,
      platform: "win32",
      sessionRoot: "C:\\Users\\test\\.codex\\sessions",
      rolloutActivityReader: { readMany },
    });

    await expect(adapter.discoverSessions()).resolves.toEqual([
      expect.objectContaining({
        nativeSessionId: thread.id,
        occupancy: expected.occupancy,
        status: expected.status,
        canResume: expected.canResume,
      }),
    ]);
    expect(request).toHaveBeenCalledWith("thread/list", expect.objectContaining({
      sortKey: "recency_at",
      sortDirection: "desc",
    }));
  });
});

describe("Codex project workspace index", () => {
  it("uses native project identity, names, and position order and refreshes after project changes", async () => {
    let notify: (message: any) => void = () => undefined;
    let revision = 0;
    const request = vi.fn(async (method: string) => {
      if (method !== "project/list") throw new Error(`unexpected request: ${method}`);
      revision += 1;
      return {
        data: [
          { id: "project-b", name: revision === 1 ? "Beta" : "Beta renamed", roots: [{ path: "/beta" }], position: 20, updatedAt: revision },
          { id: "project-a", name: "Alpha", roots: [{ path: "/alpha" }], position: 10, updatedAt: revision },
        ],
        nextCursor: null,
      };
    });
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: (handler: typeof notify) => { notify = handler; return () => undefined; },
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
      } as never,
      discoveryClient: {
        request,
        restart: async () => undefined,
        dispose: async () => undefined,
      } as never,
    });

    const first = await adapter.listWorkspaces();
    expect(first.data.map(({ workspaceId, name, order }) => [workspaceId, name, order])).toEqual([
      ["project-b", "Beta", 20],
      ["project-a", "Alpha", 10],
    ]);

    notify({ method: "project/changed", params: { projectId: "project-b", changeType: "updated" } });
    const refreshed = await adapter.listWorkspaces();
    expect(refreshed.data[0]).toMatchObject({ workspaceId: "project-b", name: "Beta renamed" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("queries native project sessions by roots so unassigned Desktop threads remain visible", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-project-index-"));
    temporaryDirectories.push(root);
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const thread = {
      id: "thread-1",
      parentThreadId: null,
      preview: "project session",
      name: null,
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: "desktop",
      turns: [],
      projectId: "project-1",
    };
    const unassignedThread = {
      ...thread,
      id: "thread-unassigned",
      name: "unassigned Desktop thread",
      projectId: null,
    };
    const discoveryClient = {
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === "project/list") {
          return { data: [{ id: "project-1", name: "Repo", roots: [{ path: root }], position: 0, updatedAt: 1 }], nextCursor: null };
        }
        if (method === "thread/list") return { data: [unassignedThread, thread], nextCursor: null };
        throw new Error(`unexpected request: ${method}`);
      },
      restart: async () => undefined,
      dispose: async () => undefined,
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
      } as never,
      discoveryClient: discoveryClient as never,
      sessionRoot: root,
      rolloutActivityReader: { readMany: async () => new Map() },
    });

    await adapter.listWorkspaces();
    await expect(adapter.listWorkspaceSessions("project-1")).resolves.toMatchObject({
      data: [
        expect.objectContaining({ nativeSessionId: "thread-unassigned" }),
        expect.objectContaining({ nativeSessionId: "thread-1" }),
      ],
    });
    expect(requests.find((entry) => entry.method === "thread/list")?.params).toMatchObject({
      cwd: [root],
      sortKey: "recency_at",
      sortDirection: "desc",
    });
    expect(requests.find((entry) => entry.method === "thread/list")?.params).not.toHaveProperty("projectId");
  });

  it("preserves authoritative recency order when updated timestamps imply another order", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-recency-order-"));
    temporaryDirectories.push(root);
    const thread = (id: string, updatedAt: number) => ({
      id,
      parentThreadId: null,
      preview: id,
      name: id,
      createdAt: 1_788_220_800,
      updatedAt,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: "desktop",
      turns: [],
    });
    const discoveryClient = {
      mode: "shared" as const,
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method !== "thread/list") throw new Error(`unexpected request: ${method}`);
        expect(params).toMatchObject({ sortKey: "recency_at", sortDirection: "desc" });
        return {
          data: [thread("recency-first", 100), thread("recency-second", 300)],
          nextCursor: null,
        };
      }),
      restart: vi.fn(async () => undefined),
      dispose: vi.fn(async () => undefined),
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
      } as never,
      discoveryClient: discoveryClient as never,
      sessionRoot: root,
      rolloutActivityReader: { readMany: async () => new Map() },
    });

    const page = await adapter.listWorkspaceSessionsByPath(root, { refresh: true });

    expect(page.data.map((session) => session.nativeSessionId)).toEqual([
      "recency-first",
      "recency-second",
    ]);
    expect(discoveryClient.restart).not.toHaveBeenCalled();
  });

  it("queries imported workspace sessions by cwd without a project ID", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-imported-index-"));
    temporaryDirectories.push(root);
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const discoveryClient = {
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push({ method, params });
        if (method === "thread/list") return { data: [], nextCursor: null };
        throw new Error(`unexpected request: ${method}`);
      },
      restart: async () => undefined,
      dispose: async () => undefined,
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
      } as never,
      discoveryClient: discoveryClient as never,
      sessionRoot: root,
      rolloutActivityReader: { readMany: async () => new Map() },
    });

    await adapter.listWorkspaceSessionsByPath(root, { limit: 25 });

    expect(requests[0]).toEqual({
      method: "thread/list",
      params: {
        cursor: null,
        limit: 25,
        sortKey: "recency_at",
        sortDirection: "desc",
        cwd: [root],
      },
    });
  });

  it("refreshes native titles through discovery without restarting execution", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discovery-refresh-"));
    temporaryDirectories.push(root);
    let requestCount = 0;
    const executionRestart = vi.fn(async () => undefined);
    const discoveryRestart = vi.fn(async () => undefined);
    const thread = (refreshed: boolean) => ({
      id: "thread-refresh",
      parentThreadId: null,
      preview: "stale preview",
      name: refreshed ? "current native title" : null,
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: "desktop",
      turns: [],
    });
    const executionClient = {
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: vi.fn(),
      restart: executionRestart,
      dispose: vi.fn(async () => undefined),
    };
    const discoveryClient = {
      mode: "shared" as const,
      request: vi.fn(async (method: string) => {
        if (method === "thread/list") {
          requestCount += 1;
          return { data: [thread(requestCount > 1)], nextCursor: null };
        }
        throw new Error(`unexpected request: ${method}`);
      }),
      restart: discoveryRestart,
      dispose: vi.fn(async () => undefined),
    };
    const adapter = new CodexRuntimeAdapter({
      client: executionClient as never,
      discoveryClient: discoveryClient as never,
      sessionRoot: root,
      rolloutActivityReader: { readMany: async () => new Map() },
    });

    await expect(adapter.listWorkspaceSessionsByPath(root)).resolves.toMatchObject({
      data: [expect.objectContaining({ title: "stale preview" })],
    });
    await expect(adapter.listWorkspaceSessionsByPath(root, { refresh: true })).resolves.toMatchObject({
      data: [expect.objectContaining({ title: "current native title" })],
    });

    expect(discoveryRestart).not.toHaveBeenCalled();
    expect(executionRestart).not.toHaveBeenCalled();
    expect(discoveryClient.request).toHaveBeenLastCalledWith("thread/list", expect.objectContaining({
      sortKey: "recency_at",
      sortDirection: "desc",
    }));
  });

  it("does not restart discovery for cursor continuation pages", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discovery-cursor-"));
    temporaryDirectories.push(root);
    const discoveryRestart = vi.fn(async () => undefined);
    const discoveryClient = {
      mode: "shared" as const,
      request: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method !== "thread/list") throw new Error(`unexpected request: ${method}`);
        return { data: [], nextCursor: params.cursor ? null : "page-2" };
      }),
      restart: discoveryRestart,
      dispose: vi.fn(async () => undefined),
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
      } as never,
      discoveryClient: discoveryClient as never,
      sessionRoot: root,
      rolloutActivityReader: { readMany: async () => new Map() },
    });

    await adapter.listWorkspaceSessionsByPath(root, { refresh: true, limit: 1 });
    await adapter.listWorkspaceSessionsByPath(root, { refresh: true, cursor: "page-2", limit: 1 });

    expect(discoveryRestart).not.toHaveBeenCalled();
    expect(discoveryClient.request).toHaveBeenNthCalledWith(2, "thread/list", expect.objectContaining({
      cursor: "page-2",
      sortKey: "recency_at",
    }));
  });

  it("reuses one shared discovery transport across concurrent refreshes", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discovery-concurrent-"));
    temporaryDirectories.push(root);
    const discoveryRestart = vi.fn(async () => undefined);
    const discoveryClient = {
      mode: "shared" as const,
      request: vi.fn(async (method: string) => {
        if (method === "thread/list") return { data: [], nextCursor: null };
        throw new Error(`unexpected request: ${method}`);
      }),
      restart: discoveryRestart,
      dispose: vi.fn(async () => undefined),
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
      } as never,
      discoveryClient: discoveryClient as never,
      sessionRoot: root,
      rolloutActivityReader: { readMany: async () => new Map() },
    });

    const first = adapter.listWorkspaceSessionsByPath(root, { refresh: true });
    const second = adapter.listWorkspaceSessionsByPath(root, { refresh: true });
    await Promise.all([first, second]);

    expect(discoveryRestart).not.toHaveBeenCalled();
    expect(discoveryClient.request).toHaveBeenCalledTimes(2);
  });

  it("rate-limits standalone discovery restarts while preserving refresh requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-discovery-standalone-"));
    temporaryDirectories.push(root);
    let now = 1_000;
    const discoveryRestart = vi.fn(async () => undefined);
    const discoveryClient = {
      mode: "standalone" as const,
      request: vi.fn(async (method: string) => {
        if (method === "thread/list") return { data: [], nextCursor: null };
        throw new Error(`unexpected request: ${method}`);
      }),
      restart: discoveryRestart,
      dispose: vi.fn(async () => undefined),
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
      } as never,
      discoveryClient: discoveryClient as never,
      sessionRoot: root,
      rolloutActivityReader: { readMany: async () => new Map() },
      standaloneDiscoveryRestartIntervalMs: 30_000,
      now: () => now,
    });

    await adapter.listWorkspaceSessionsByPath(root, { refresh: true });
    now += 10_000;
    await adapter.listWorkspaceSessionsByPath(root, { refresh: true });
    now += 20_000;
    await adapter.listWorkspaceSessionsByPath(root, { refresh: true });

    expect(discoveryRestart).toHaveBeenCalledTimes(2);
    expect(discoveryClient.request).toHaveBeenCalledTimes(3);
  });

  it("disposes distinct discovery and execution clients exactly once", async () => {
    const executionDispose = vi.fn(async () => undefined);
    const discoveryDispose = vi.fn(async () => undefined);
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: vi.fn(),
        dispose: executionDispose,
      } as never,
      discoveryClient: {
        request: vi.fn(),
        restart: vi.fn(async () => undefined),
        dispose: discoveryDispose,
      } as never,
    });

    await adapter.dispose();

    expect(executionDispose).toHaveBeenCalledTimes(1);
    expect(discoveryDispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a shared injected client only once", async () => {
    const dispose = vi.fn(async () => undefined);
    const sharedClient = {
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: vi.fn(),
      restart: vi.fn(async () => undefined),
      dispose,
    };
    const adapter = new CodexRuntimeAdapter({
      client: sharedClient as never,
      discoveryClient: sharedClient as never,
    });

    await adapter.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("assigns newly created threads to the selected native project", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const thread = {
      id: "new-thread",
      parentThreadId: null,
      preview: "",
      name: null,
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: "/repo",
      source: "desktop",
      turns: [],
      projectId: null,
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          if (method === "thread/start") return { thread };
          return {};
        },
      } as never,
    });

    const created = await adapter.create({ title: "New", cwd: "/repo", projectId: "project-1" });

    expect(requests[0]).toEqual({
      method: "thread/start",
      params: { cwd: "/repo", threadSource: "customer-agent", projectId: "project-1" },
    });
    expect(created.projectId).toBe("project-1");
  });

  it("creates a cwd-only thread for an imported workspace", async () => {
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    const thread = {
      id: "imported-thread",
      parentThreadId: null,
      preview: "",
      name: null,
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: "/manual/repo",
      source: "desktop",
      turns: [],
      projectId: null,
    };
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request: async (method: string, params: Record<string, unknown>) => {
          requests.push({ method, params });
          if (method === "thread/start") return { thread };
          return {};
        },
      } as never,
    });

    await adapter.create({ title: "New", cwd: "/manual/repo" });

    expect(requests[0]).toEqual({
      method: "thread/start",
      params: { cwd: "/manual/repo", threadSource: "customer-agent" },
    });
  });
});

describe("Codex reasoning mapping", () => {
  it("maps public turn and reasoning-item lifecycle progress", () => {
    expect(codexProgressNotificationToEvent({
      method: "turn/started",
      params: { threadId: "thread-1", turn: { id: "turn-1" } },
    })).toEqual({
      type: "runtime_progress",
      progressId: "codex:status",
      phase: "status",
      label: "正在开始处理",
    });
    expect(codexProgressNotificationToEvent({
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "reasoning-1", type: "reasoning" } },
    })).toEqual({
      type: "runtime_progress",
      progressId: "codex:reasoning:reasoning-1",
      phase: "thinking",
      label: "正在思考",
    });
    expect(codexProgressNotificationToEvent({
      method: "item/started",
      params: { threadId: "thread-1", item: { id: "message-1", type: "agentMessage" } },
    })).toBeNull();
  });

  it("allows public summaries and rejects raw or malformed reasoning", () => {
    expect(codexReasoningNotificationToEvent({
      method: "item/reasoning/summaryTextDelta",
      params: { itemId: "reasoning-1", summaryIndex: 0, delta: "Inspecting" },
    })).toEqual({
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 0,
      delta: "Inspecting",
    });
    expect(codexReasoningNotificationToEvent({
      method: "item/reasoning/summaryPartAdded",
      params: { itemId: "reasoning-1", summaryIndex: 1 },
    })).toEqual({
      type: "reasoning_summary_delta",
      itemId: "reasoning-1",
      sectionIndex: 1,
      delta: "",
    });
    expect(codexReasoningNotificationToEvent({
      method: "item/reasoning/textDelta",
      params: { itemId: "reasoning-1", contentIndex: 0, delta: "private reasoning" },
    })).toBeNull();
    expect(codexReasoningNotificationToEvent({
      method: "item/reasoning/summaryTextDelta",
      params: { itemId: "reasoning-1", summaryIndex: -1, delta: "bad" },
    })).toBeNull();
  });

  it("restores summary history while ignoring raw reasoning content", async () => {
    const messages = await codexTurnsToMessages([{
      id: "turn-1",
      status: "completed",
      items: [
        { type: "reasoning", id: "reasoning-1", summary: ["Checked files"], content: ["private chain"] },
        { type: "commandExecution", id: "call-1", command: "pwd", cwd: "/repo", aggregatedOutput: "/repo" },
        { type: "agentMessage", id: "answer-1", text: "Done" },
      ],
    }]);

    expect(messages[0]).toEqual({
      role: "assistant",
      content: "",
      historyId: "codex-trace:turn-1:reasoning:reasoning-1",
      presentation: { reasoning: [{ itemId: "reasoning-1", sectionIndex: 0, text: "Checked files" }] },
    });
    expect(JSON.stringify(messages)).not.toContain("private chain");
    expect(messages.map((message) => message.role)).toEqual(["assistant", "assistant", "tool", "assistant"]);
    expect(messages.at(-1)?.content).toBe("Done");
  });

  it("preserves Codex agent message phases for presentation filtering", async () => {
    const messages = await codexTurnsToMessages([{
      id: "turn-1",
      status: "completed",
      items: [
        { type: "agentMessage", id: "commentary-1", text: "正在检查文件", phase: "commentary" },
        { type: "agentMessage", id: "answer-1", text: "检查完成", phase: "final_answer" },
      ],
    }]);

    expect(messages).toEqual([
      {
        role: "assistant",
        content: "正在检查文件",
        historyId: "codex-trace:turn-1:agent:commentary-1",
        presentation: { agentMessagePhase: "commentary" },
      },
      {
        role: "assistant",
        content: "检查完成",
        historyId: "codex-trace:turn-1:agent:answer-1",
        presentation: { agentMessagePhase: "final_answer" },
      },
    ]);
  });
});

describe("Codex live execution events", () => {
  it("attaches the native turn ID to streamed tool calls and results", async () => {
    let notify: (message: any) => void = () => undefined;
    const thread = {
      id: "cx-live-tools",
      parentThreadId: null,
      preview: "live tools",
      name: "live tools",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: "/repo",
      source: { custom: "customer-agent" },
      turns: [],
    };
    const client = {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string) => {
        if (method === "thread/read" || method === "thread/resume") return { thread };
        if (method === "turn/start") {
          queueMicrotask(() => {
            notify({
              method: "item/started",
              params: {
                threadId: thread.id,
                turnId: "turn-live",
                item: { id: "commentary-1", type: "agentMessage", text: "", phase: "commentary" },
              },
            });
            notify({
              method: "item/agentMessage/delta",
              params: {
                threadId: thread.id,
                turnId: "turn-live",
                itemId: "commentary-1",
                delta: "Checking files",
              },
            });
            notify({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId: "turn-live",
                item: { id: "commentary-1", type: "agentMessage", text: "Checking files", phase: "commentary" },
              },
            });
            notify({
              method: "item/started",
              params: {
                threadId: thread.id,
                turnId: "turn-live",
                item: {
                  id: "call-1",
                  type: "commandExecution",
                  command: "cat /repo/SKILL.md",
                  cwd: "/repo",
                  commandActions: [{
                    type: "read",
                    command: "cat /repo/SKILL.md",
                    name: "SKILL.md",
                    path: "/repo/SKILL.md",
                  }],
                },
              },
            });
            notify({
              method: "item/completed",
              params: {
                threadId: thread.id,
                turnId: "turn-live",
                item: {
                  id: "call-1",
                  type: "commandExecution",
                  command: "cat /repo/SKILL.md",
                  cwd: "/repo",
                  commandActions: [{
                    type: "read",
                    command: "cat /repo/SKILL.md",
                    name: "SKILL.md",
                    path: "/repo/SKILL.md",
                  }],
                  aggregatedOutput: "skill instructions",
                  exitCode: 0,
                },
              },
            });
            notify({
              method: "item/started",
              params: {
                threadId: thread.id,
                turnId: "turn-live",
                item: { id: "answer-1", type: "agentMessage", text: "", phase: "final_answer" },
              },
            });
            notify({
              method: "item/agentMessage/delta",
              params: {
                threadId: thread.id,
                turnId: "turn-live",
                itemId: "answer-1",
                delta: "Done",
              },
            });
            notify({
              method: "turn/completed",
              params: {
                threadId: thread.id,
                turn: {
                  id: "turn-live",
                  status: "completed",
                  items: [{ id: "answer-1", type: "agentMessage", text: "Done", phase: "final_answer" }],
                },
              },
            });
          });
          return { turn: { id: "turn-live" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp" });

    const events = await drain(adapter.run(thread.id, "run pwd"));

    expect(events).toContainEqual(expect.objectContaining({
      type: "text_chunk",
      text: "Checking files",
      turnId: "turn-live",
      itemId: "commentary-1",
      messagePhase: "commentary",
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_call",
      turnId: "turn-live",
      toolCall: {
        id: "call-1",
        name: "read_file",
        arguments: {
          file_path: "/repo/SKILL.md",
          command: "cat /repo/SKILL.md",
          cwd: "/repo",
        },
      },
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "tool_result",
      turnId: "turn-live",
      result: expect.objectContaining({ toolCallId: "call-1", content: "skill instructions" }),
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: "text_chunk",
      text: "Done",
      turnId: "turn-live",
      itemId: "answer-1",
      messagePhase: "final_answer",
    }));
  });
});

describe("Codex steering and user interruption", () => {
  const thread = {
    id: "cx-steering",
    parentThreadId: null,
    preview: "steering",
    name: "steering",
    createdAt: 1_788_220_800,
    updatedAt: 1_788_220_800,
    status: { type: "idle" },
    path: null,
    cwd: "/repo",
    source: { custom: "customer-agent" },
    turns: [],
  };

  function setup(options: {
    steerError?: Error;
    interruptError?: Error;
    turnIds?: string[];
    reconciliationFailures?: number;
    reconciliationTurns?: Array<{ id: string; status: string; items: any[]; error?: { message?: string } }>;
  } = {}) {
    let notify: (message: any) => void = () => undefined;
    let turnStartIndex = 0;
    let threadReadCount = 0;
    const requests: Array<{ method: string; params: any }> = [];
    const client = {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "thread/read") {
          threadReadCount += 1;
          if (threadReadCount > 1 && threadReadCount <= 1 + (options.reconciliationFailures ?? 0)) {
            throw new Error("temporary thread/read failure");
          }
          return threadReadCount === 1
            ? { thread }
            : { thread: { ...thread, turns: options.reconciliationTurns ?? [] } };
        }
        if (method === "thread/resume") return { thread };
        if (method === "turn/start") {
          return { turn: { id: options.turnIds?.[turnStartIndex++] ?? "turn-steering" } };
        }
        if (method === "turn/steer") {
          if (options.steerError) throw options.steerError;
          return {};
        }
        if (method === "turn/interrupt") {
          if (options.interruptError) throw options.interruptError;
          return {};
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    return {
      adapter: new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp" }),
      notify,
      requests,
    };
  }

  async function waitForTurnStart(requests: Array<{ method: string }>, count = 1): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (requests.filter(({ method }) => method === "turn/start").length >= count) {
        await Promise.resolve();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error("Codex test turn did not start");
  }

  it("steers text into the exact active turn and rejects idle or blank input", async () => {
    const { adapter, notify, requests } = setup();
    await expect(adapter.steer(thread.id, "before start")).resolves.toBe(false);

    const run = drain(adapter.run(thread.id, "start"));
    await waitForTurnStart(requests);
    await expect(adapter.steer(thread.id, "   ")).resolves.toBe(false);
    await expect(adapter.steer(thread.id, "use this now")).resolves.toBe(true);

    expect(requests.filter(({ method }) => method === "turn/steer")).toEqual([{
      method: "turn/steer",
      params: {
        threadId: thread.id,
        expectedTurnId: "turn-steering",
        input: [{ type: "text", text: "use this now", text_elements: [] }],
      },
    }]);

    notify({
      method: "turn/completed",
      params: { threadId: thread.id, turn: { id: "turn-steering", status: "completed", items: [] } },
    });
    await expect(run).resolves.toContainEqual({ type: "done", finalText: "" });
  });

  it("keeps the active run open when steering is rejected", async () => {
    const { adapter, notify, requests } = setup({ steerError: new Error("stale turn") });
    const run = drain(adapter.run(thread.id, "start"));
    await waitForTurnStart(requests);

    await expect(adapter.steer(thread.id, "retry later")).rejects.toThrow("stale turn");
    notify({
      method: "turn/completed",
      params: { threadId: thread.id, turn: { id: "turn-steering", status: "completed", items: [] } },
    });
    const events = await run;
    expect(events).toContainEqual({ type: "done", finalText: "" });
    expect(events.some((event: any) => event.type === "error")).toBe(false);
  });

  it("turns a locally requested interruption into normal completion", async () => {
    const { adapter, notify, requests } = setup();
    const run = drain(adapter.run(thread.id, "start"));
    await waitForTurnStart(requests);

    await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
    notify({
      method: "turn/completed",
      params: {
        threadId: thread.id,
        turn: {
          id: "turn-steering",
          status: "interrupted",
          items: [{ type: "agentMessage", text: "partial answer" }],
        },
      },
    });

    const events = await run;
    expect(events.filter((event: any) => event.type === "done" || event.type === "error"))
      .toEqual([{ type: "done", finalText: "partial answer" }]);
    expect(requests).toContainEqual({
      method: "turn/interrupt",
      params: { threadId: thread.id, turnId: "turn-steering" },
    });
  });

  it("turns a matching local interrupt notification into normal completion", async () => {
    const { adapter, notify, requests } = setup();
    const run = drain(adapter.run(thread.id, "start"));
    await waitForTurnStart(requests);

    await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
    notify({
      method: "turn/interrupt",
      params: { threadId: thread.id, turnId: "turn-steering" },
    });

    const events = await run;
    expect(events.filter((event: any) => event.type === "done" || event.type === "error"))
      .toEqual([{ type: "done", finalText: "" }]);
  });

  it("reconciles an already-terminal interruption after 30 seconds", async () => {
    const { adapter, requests } = setup({
      turnIds: ["turn-reconciled"],
      reconciliationTurns: [{
        id: "turn-reconciled",
        status: "interrupted",
        items: [{ type: "agentMessage", text: "late partial answer" }],
      }],
    });
    const run = drain(adapter.run(thread.id, "first"));
    await waitForTurnStart(requests);

    vi.useFakeTimers();
    try {
      await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(30_001);
      await expect(run).resolves.toContainEqual({ type: "done", finalText: "late partial answer" });
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries interruption once when reconciliation still reports the turn active", async () => {
    const { adapter, notify, requests } = setup({
      turnIds: ["turn-still-active"],
      reconciliationTurns: [{ id: "turn-still-active", status: "inProgress", items: [] }],
    });
    const run = drain(adapter.run(thread.id, "first"));
    await waitForTurnStart(requests);

    vi.useFakeTimers();
    try {
      await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(2);
      notify({
        method: "turn/completed",
        params: {
          threadId: thread.id,
          turn: { id: "turn-still-active", status: "interrupted", items: [] },
        },
      });
      await expect(run).resolves.toContainEqual({ type: "done", finalText: "" });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries transient reconciliation failures within the confirmation deadline", async () => {
    const { adapter, notify, requests } = setup({
      turnIds: ["turn-retry-read"],
      reconciliationFailures: 1,
      reconciliationTurns: [{ id: "turn-retry-read", status: "inProgress", items: [] }],
    });
    const run = drain(adapter.run(thread.id, "first"));
    await waitForTurnStart(requests);

    vi.useFakeTimers();
    try {
      await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_001);
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(2);
      notify({
        method: "turn/completed",
        params: {
          threadId: thread.id,
          turn: { id: "turn-retry-read", status: "interrupted", items: [] },
        },
      });
      await expect(run).resolves.toContainEqual({ type: "done", finalText: "" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a recoverable timeout after 60 seconds without an authoritative terminal state", async () => {
    const { adapter, notify, requests } = setup({
      turnIds: ["turn-timeout"],
      reconciliationTurns: [{ id: "turn-timeout", status: "inProgress", items: [] }],
    });
    const run = drain(adapter.run(thread.id, "first"));
    await waitForTurnStart(requests);

    vi.useFakeTimers();
    try {
      await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_001);
      await expect(run).resolves.toContainEqual({
        type: "error",
        code: "CANCEL_CONFIRMATION_TIMEOUT",
        message: "停止确认超时；Codex 可能仍在结束当前任务。请重试停止或释放会话。",
      });
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(2);
      await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(3);
      notify({
        method: "turn/completed",
        params: {
          threadId: thread.id,
          turn: { id: "turn-timeout", status: "interrupted", items: [] },
        },
      });
      await expect(adapter.abort(thread.id)).resolves.toBeUndefined();
      expect(requests.filter(({ method }) => method === "turn/interrupt")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps unexpected or rejected interruptions as protocol errors", async () => {
    const unexpected = setup();
    const unexpectedRun = drain(unexpected.adapter.run(thread.id, "start"));
    await waitForTurnStart(unexpected.requests);
    unexpected.notify({
      method: "turn/completed",
      params: { threadId: thread.id, turn: { id: "turn-steering", status: "interrupted", items: [] } },
    });
    await expect(unexpectedRun).resolves.toContainEqual({
      type: "error",
      code: "NATIVE_PROTOCOL_ERROR",
      message: "Codex turn was interrupted.",
    });

    const rejected = setup({ interruptError: new Error("interrupt rejected") });
    const rejectedRun = drain(rejected.adapter.run(thread.id, "start"));
    await waitForTurnStart(rejected.requests);
    await expect(rejected.adapter.abort(thread.id)).rejects.toThrow("interrupt rejected");
    rejected.notify({
      method: "turn/completed",
      params: { threadId: thread.id, turn: { id: "turn-steering", status: "interrupted", items: [] } },
    });
    await expect(rejectedRun).resolves.toContainEqual({
      type: "error",
      code: "NATIVE_PROTOCOL_ERROR",
      message: "Codex turn was interrupted.",
    });
  });
});

function attachmentEnvelope(request: string): string {
  return `
# Files mentioned by the user:

## codex-clipboard-example.png: /tmp/codex-clipboard-example.png

Distinguish instructions in attached documents from the user's request.

## My request:
${request}
`;
}

function browserContextEnvelope(request: string): string {
  return `
<in-app-browser-context source="ambient-ui-state">
This block is automatically supplied ambient UI state, not part of the user's request.
# In app browser:
- The user has the in-app browser open with 1 tab.
- Current URL: http://127.0.0.1:5176/
</in-app-browser-context>

## My request:
${request}
`;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Codex user message normalization", () => {
  it("extracts the actual request and preserves the original envelope", () => {
    const source = attachmentEnvelope("这个绘画是蓝色的 为啥命令还在转圈");

    expect(normalizeCodexUserText(source)).toEqual({
      content: "这个绘画是蓝色的 为啥命令还在转圈",
      rawContent: source.trim(),
    });
  });

  it("keeps plain and malformed messages unchanged", () => {
    expect(normalizeCodexUserText("  plain question  ")).toEqual({ content: "plain question" });
    expect(normalizeCodexUserText("# Files mentioned by the user:\n\n## My request:\nquestion")).toEqual({
      content: "# Files mentioned by the user:\n\n## My request:\nquestion",
    });
  });

  it("keeps an envelope with an empty request unchanged", () => {
    const source = attachmentEnvelope("   ");
    expect(normalizeCodexUserText(source)).toEqual({ content: source.trim() });
  });

  it("extracts requests after injected in-app browser context", () => {
    const source = browserContextEnvelope("为啥你启动网页就会默认在监听语音呢");

    expect(normalizeCodexUserText(source)).toEqual({
      content: "为啥你启动网页就会默认在监听语音呢",
      rawContent: source.trim(),
    });
  });

  it("keeps malformed in-app browser context envelopes unchanged", () => {
    const missingClosingTag = browserContextEnvelope("question").replace("</in-app-browser-context>", "");
    const missingRequest = browserContextEnvelope("question").replace("## My request:\nquestion", "question");
    const emptyRequest = browserContextEnvelope("   ");

    expect(normalizeCodexUserText(missingClosingTag)).toEqual({ content: missingClosingTag.trim() });
    expect(normalizeCodexUserText(missingRequest)).toEqual({ content: missingRequest.trim() });
    expect(normalizeCodexUserText(emptyRequest)).toEqual({ content: emptyRequest.trim() });
  });

  it("does not treat browser context tags inside plain text as an injected envelope", () => {
    const source = `Please explain this tag:\n${browserContextEnvelope("question").trim()}`;
    expect(normalizeCodexUserText(source)).toEqual({ content: source });
  });
});

describe("Codex history mapping", () => {
  it("presents a single structured read command as a file read", async () => {
    const messages = await codexTurnsToMessages([{
      id: "turn-read",
      status: "completed",
      items: [
        {
          type: "commandExecution",
          id: "read-1",
          command: "cat /repo/SKILL.md",
          cwd: "/repo",
          commandActions: [{
            type: "read",
            command: "cat /repo/SKILL.md",
            name: "SKILL.md",
            path: "/repo/SKILL.md",
          }],
          aggregatedOutput: "skill instructions",
        },
        {
          type: "commandExecution",
          id: "mixed-1",
          command: "cat /repo/SKILL.md | rg rule",
          cwd: "/repo",
          commandActions: [
            { type: "read", command: "cat /repo/SKILL.md", name: "SKILL.md", path: "/repo/SKILL.md" },
            { type: "search", command: "rg rule", query: "rule", path: null },
          ],
          aggregatedOutput: "rule",
        },
      ],
    }]);

    expect(messages.filter((message) => message.role === "assistant").map((message) => message.toolCalls?.[0]))
      .toEqual([
        {
          id: "read-1",
          name: "read_file",
          arguments: {
            file_path: "/repo/SKILL.md",
            command: "cat /repo/SKILL.md",
            cwd: "/repo",
          },
        },
        {
          id: "mixed-1",
          name: "shell",
          arguments: { command: "cat /repo/SKILL.md | rg rule", cwd: "/repo" },
        },
      ]);
    expect(messages.filter((message) => message.role === "tool").map((message) => message.name))
      .toEqual(["read_file", "shell"]);
  });

  it("loads image entries as ordered data URL attachments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-runtime-adapter-"));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, "first.png");
    const secondPath = join(directory, "second.jpg");
    await writeFile(firstPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(secondPath, Buffer.from([0xff, 0xd8, 0xff]));

    const messages = await codexTurnsToMessages([{
      id: "turn-1",
      status: "completed",
      items: [{
        type: "userMessage",
        content: [
          { type: "text", text: attachmentEnvelope("inspect both") },
          { type: "localImage", path: firstPath },
          { type: "local_image", path: secondPath },
        ],
      }],
    }]);

    expect(messages).toEqual([{
      role: "user",
      content: "inspect both",
      presentation: {
        rawContent: attachmentEnvelope("inspect both").trim(),
        attachments: [
          { type: "image", name: "first.png", dataUrl: "data:image/png;base64,iVBORw==" },
          { type: "image", name: "second.jpg", dataUrl: "data:image/jpeg;base64,/9j/" },
        ],
      },
    }]);
  });

  it("keeps missing images as unavailable attachments without exposing their path", async () => {
    const missingPath = "/tmp/codex-runtime-adapter-does-not-exist.png";
    const messages = await codexTurnsToMessages([{
      id: "turn-1",
      status: "completed",
      items: [{
        type: "userMessage",
        content: [
          { type: "text", text: "look at this" },
          { type: "local_image", path: missingPath },
        ],
      }],
    }]);

    expect(messages).toEqual([{
      role: "user",
      content: "look at this",
      presentation: {
        attachments: [{ type: "image", name: "codex-runtime-adapter-does-not-exist.png", unavailable: true }],
      },
    }]);
    expect(JSON.stringify(messages[0].presentation?.attachments)).not.toContain(missingPath);
  });

  it("preserves multiple text entries and assistant messages", async () => {
    const messages = await codexTurnsToMessages([{
      id: "turn-1",
      status: "completed",
      items: [
        { type: "userMessage", content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] },
        { type: "agentMessage", text: "answer" },
      ],
    }]);

    expect(messages).toEqual([
      { role: "user", content: "first\nsecond" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("bounds trace reasoning and arguments while omitting large tool bodies", async () => {
    const largeResult = "r".repeat(100_000);
    const messages = await codexTurnsToMessages([{
      id: "turn-1",
      status: "completed",
      items: [
        { type: "reasoning", id: "reasoning-1", summary: ["思".repeat(10_000)] },
        { type: "commandExecution", id: "call-1", command: "x".repeat(10_000), aggregatedOutput: largeResult },
      ],
    }], {
      toolResultMode: "lazy",
      revision: "rev-1",
      reasoningMaxBytes: 4 * 1024,
      toolArgumentsMaxBytes: 2 * 1024,
    });

    const reasoning = messages[0].presentation?.reasoning?.[0].text ?? "";
    const args = messages.find((message) => message.toolCalls)?.toolCalls?.[0].arguments ?? {};
    const result = messages.find((message) => message.role === "tool");
    expect(Buffer.byteLength(reasoning, "utf8")).toBeLessThanOrEqual(4 * 1024);
    expect(Buffer.byteLength(JSON.stringify(args), "utf8")).toBeLessThanOrEqual(2 * 1024);
    expect(result).toMatchObject({ content: "", toolResultRef: { byteSize: 100_000 } });
    expect(JSON.stringify(messages)).not.toContain(largeResult);
  });
});

describe("Codex session forks", () => {
  it("forks stored history, applies a copy title, and returns the new unified session", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const sourceThread = {
      id: "cx-source",
      parentThreadId: null,
      preview: "原会话预览",
      name: "原会话",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: "/tmp/source.jsonl",
      cwd: "/tmp/project",
      source: "vscode",
      turns: [],
    };
    const forkThread = {
      ...sourceThread,
      id: "cx-fork",
      name: null,
      path: "/tmp/fork.jsonl",
      source: { custom: "customer-agent" },
    };
    const client = {
      pid: 321,
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/read") return { thread: sourceThread };
        if (method === "thread/fork") return { thread: forkThread };
        if (method === "thread/name/set") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp" });

    const result = await adapter.fork("cx-source");

    expect(requests).toEqual([
      {
        method: "thread/read",
        params: { threadId: "cx-source", includeTurns: false },
      },
      {
        method: "thread/fork",
        params: { threadId: "cx-source" },
      },
      {
        method: "thread/name/set",
        params: { threadId: "cx-fork", name: "原会话（副本）" },
      },
    ]);
    expect(result).toMatchObject({
      agentType: "codex",
      nativeSessionId: "cx-fork",
      title: "原会话（副本）",
      occupancy: "available",
      canResume: true,
    });
  });
});

describe("Codex session rename", () => {
  it("updates the native thread name", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const client = {
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: unknown) => {
        requests.push({ method, params });
        return {};
      },
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp" });

    await adapter.renameSession("thread-1", "第一条消息");

    expect(requests).toEqual([{
      method: "thread/name/set",
      params: { threadId: "thread-1", name: "第一条消息" },
    }]);
  });
});

describe("Codex image input", () => {
  it("writes ordered localImage inputs for turn/start and keeps accepted image files", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-image-input-"));
    temporaryDirectories.push(root);
    const imageStorageRoot = join(root, "images");
    const requests: Array<{ method: string; params: any }> = [];
    const capturedBytes: Buffer[] = [];
    const capturedPaths: string[] = [];
    let notify: (message: any) => void = () => undefined;
    const thread = {
      id: "cx-images",
      parentThreadId: null,
      preview: "images",
      name: "images",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: { custom: "customer-agent" },
      turns: [],
    };
    const client = {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "thread/read") return { thread };
        if (method === "thread/resume") return { thread };
        if (method === "turn/start") {
          for (const item of params.input.slice(1)) {
            capturedPaths.push(item.path);
            capturedBytes.push(await readFile(item.path));
          }
          queueMicrotask(() => notify({
            method: "turn/completed",
            params: {
              threadId: thread.id,
              turn: { id: "turn-images", status: "completed", items: [] },
            },
          }));
          return { turn: { id: "turn-images" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const adapter = new CodexRuntimeAdapter({
      client: client as never,
      sessionRoot: root,
      imageStorageRoot,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0x01]);

    await drain(adapter.run(thread.id, "inspect both", [
      `data:image/png;base64,${png.toString("base64")}`,
      `data:image/jpeg;base64,${jpeg.toString("base64")}`,
    ]));

    const turnStart = requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params.input).toMatchObject([
      { type: "text", text: "inspect both", text_elements: [] },
      { type: "localImage", path: expect.stringMatching(/image-1\.png$/) },
      { type: "localImage", path: expect.stringMatching(/image-2\.jpg$/) },
    ]);
    expect(capturedBytes).toEqual([png, jpeg]);
    expect(await Promise.all(capturedPaths.map((path) => readFile(path)))).toEqual([png, jpeg]);
    expect(await readdir(imageStorageRoot)).toHaveLength(1);
  });

  it("removes image files when Codex rejects turn/start", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-image-rejected-"));
    temporaryDirectories.push(root);
    const imageStorageRoot = join(root, "images");
    const thread = {
      id: "cx-rejected-images",
      parentThreadId: null,
      preview: "images",
      name: "images",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: { custom: "customer-agent" },
      turns: [],
    };
    const client = {
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string) => {
        if (method === "thread/read" || method === "thread/resume") return { thread };
        if (method === "turn/start") throw new Error("turn rejected");
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const adapter = new CodexRuntimeAdapter({
      client: client as never,
      sessionRoot: root,
      imageStorageRoot,
    });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

    const events = await drain(adapter.run(
      thread.id,
      "inspect",
      [`data:image/png;base64,${png.toString("base64")}`],
    ));

    expect(events).toEqual([expect.objectContaining({ type: "error", message: "turn rejected" })]);
    expect(await readdir(imageStorageRoot)).toEqual([]);
  });

  it("rejects malformed image data before starting a turn", async () => {
    const requests: string[] = [];
    const thread = {
      id: "cx-invalid-image",
      parentThreadId: null,
      preview: "images",
      name: "images",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp",
      source: { custom: "customer-agent" },
      turns: [],
    };
    const client = {
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string) => {
        requests.push(method);
        return { thread };
      },
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp" });

    await expect(drain(adapter.run(thread.id, "inspect", ["data:image/png;base64,bm90LXBuZw=="])))
      .rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
    expect(requests).not.toContain("turn/start");
  });
});

describe("Codex native goal lifecycle", () => {
  it("keeps the run open across completed turns until the native goal is complete", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-lifecycle-"));
    temporaryDirectories.push(root);
    const requests: Array<{ method: string; params: any }> = [];
    let notify: (message: any) => void = () => undefined;
    const thread = {
      id: "cx-goal",
      parentThreadId: null,
      preview: "goal",
      name: "goal",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: { custom: "customer-agent" },
      turns: [],
    };
    const client = {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "thread/read") return { thread };
        if (method === "thread/resume") return { thread };
        if (method === "thread/goal/set") return { goal: { status: "active" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            notify({
              method: "turn/completed",
              params: {
                threadId: thread.id,
                turn: {
                  id: "turn-goal-1",
                  status: "completed",
                  items: [{ type: "agentMessage", text: "intermediate" }],
                },
              },
            });
            notify({
              method: "turn/started",
              params: { threadId: thread.id, turn: { id: "turn-goal-2" } },
            });
            notify({
              method: "thread/goal/updated",
              params: { threadId: thread.id, turnId: "turn-goal-2", goal: { status: "complete" } },
            });
            notify({
              method: "turn/completed",
              params: {
                threadId: thread.id,
                turn: {
                  id: "turn-goal-2",
                  status: "completed",
                  items: [{ type: "agentMessage", text: "goal complete" }],
                },
              },
            });
          });
          return { turn: { id: "turn-goal-1" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: root });

    const events = await drain(adapter.run(
      thread.id,
      "finish migration",
      undefined,
      undefined,
      undefined,
      { brokerRunId: "run-goal", goal: { id: "goal-1", objective: "finish migration" } },
    ));

    expect(requests).toContainEqual({
      method: "thread/goal/set",
      params: { threadId: thread.id, objective: "finish migration", status: "active" },
    });
    expect(events.filter((event: any) => event.type === "done" || event.type === "error"))
      .toEqual([{ type: "done", finalText: "goal complete" }]);
  });

  it("ignores the cleared goal snapshot emitted while resuming before a new goal is set", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-resume-snapshot-"));
    temporaryDirectories.push(root);
    let notify: (message: any) => void = () => undefined;
    const thread = {
      id: "cx-goal-resume-snapshot",
      parentThreadId: null,
      preview: "goal",
      name: "goal",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: { custom: "customer-agent" },
      turns: [],
    };
    const client = {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string) => {
        if (method === "thread/read") return { thread };
        if (method === "thread/resume") {
          notify({ method: "thread/goal/cleared", params: { threadId: thread.id } });
          return { thread };
        }
        if (method === "thread/goal/set") return { goal: { status: "active" } };
        if (method === "turn/start") {
          queueMicrotask(() => {
            notify({
              method: "turn/started",
              params: { threadId: thread.id, turn: { id: "turn-after-resume-snapshot" } },
            });
            notify({
              method: "thread/goal/updated",
              params: { threadId: thread.id, goal: { status: "complete" } },
            });
            notify({
              method: "turn/completed",
              params: {
                threadId: thread.id,
                turn: {
                  id: "turn-after-resume-snapshot",
                  status: "completed",
                  items: [{ type: "agentMessage", text: "goal complete" }],
                },
              },
            });
          });
          return { turn: { id: "turn-after-resume-snapshot" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: root });

    const events = await drain(adapter.run(
      thread.id,
      "finish migration",
      undefined,
      undefined,
      undefined,
      { goal: { id: "goal-after-resume-snapshot", objective: "finish migration" } },
    ));

    expect(events.filter((event: any) => event.type === "done" || event.type === "error"))
      .toEqual([{ type: "done", finalText: "goal complete" }]);
  });

  it("finishes a cleared native goal even when no turn has started", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-goal-cleared-"));
    temporaryDirectories.push(root);
    let notify: (message: any) => void = () => undefined;
    const thread = {
      id: "cx-goal-cleared",
      parentThreadId: null,
      preview: "goal",
      name: "goal",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: root,
      source: { custom: "customer-agent" },
      turns: [],
    };
    const client = {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string) => {
        if (method === "thread/read" || method === "thread/resume") return { thread };
        if (method === "thread/goal/set") return { goal: { status: "active" } };
        if (method === "turn/start") {
          notify({ method: "thread/goal/cleared", params: { threadId: thread.id } });
          return { turn: { id: "turn-cleared" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: root });

    const events = await drain(adapter.run(
      thread.id,
      "finish migration",
      undefined,
      undefined,
      undefined,
      { goal: { id: "goal-cleared", objective: "finish migration" } },
    ));

    expect(events.at(-1)).toEqual({
      type: "error",
      code: "NATIVE_PROTOCOL_ERROR",
      message: "Codex goal was cleared.",
    });
  });
});

describe("Codex native permissions", () => {
  it("maps every permission mode to the exact turn/start policy", () => {
    expect(codexTurnPermissionOptions("request-approval", "/repo")).toEqual({
      approvalPolicy: "onRequest",
      sandboxPolicy: { type: "readOnly" },
    });
    expect(codexTurnPermissionOptions("auto-approval", "/repo")).toEqual({
      approvalPolicy: "onRequest",
      sandboxPolicy: {
        type: "workspaceWrite",
        writableRoots: ["/repo"],
        networkAccess: false,
      },
    });
    expect(codexTurnPermissionOptions("full-access", "/repo")).toEqual({
      approvalPolicy: "never",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("auto-accepts approval requests in full-access goals while preserving user input questions", async () => {
    const thread = {
      id: "cx-full-access-permissions",
      parentThreadId: null,
      preview: "permissions",
      name: "permissions",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: "/repo",
      source: { custom: "customer-agent" },
      turns: [],
    };
    let notification: (message: any) => void = () => undefined;
    let serverRequest: (message: any) => void = () => undefined;
    let turnStarted = false;
    const responses: Array<{ id: unknown; result: unknown }> = [];
    const client = {
      onNotification: (handler: typeof notification) => {
        notification = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: (handler: typeof serverRequest) => {
        serverRequest = handler;
      },
      respond: (id: unknown, result: unknown) => {
        responses.push({ id, result });
      },
      respondError: () => undefined,
      request: async (method: string) => {
        if (method === "thread/read" || method === "thread/resume") return { thread };
        if (method === "thread/goal/set") return { goal: { status: "active" } };
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-full-access" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
      dispose: async () => undefined,
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: "/tmp" });
    const iterator = adapter.run(thread.id, "continue", undefined, undefined, undefined, {
      permissionMode: "full-access",
      brokerRunId: "run-full-access",
      goal: { id: "goal-full-access", objective: "finish the target" },
    })[Symbol.asyncIterator]();
    let nextEventSettled = false;
    const nextEvent = iterator.next().then((result) => {
      nextEventSettled = true;
      return result;
    });
    for (let attempt = 0; attempt < 150 && !turnStarted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(turnStarted).toBe(true);

    serverRequest({
      id: "legacy-command",
      method: "item/commandExecution/requestApproval",
      params: { threadId: thread.id, command: "pwd" },
    });
    serverRequest({
      id: "scoped-permissions",
      method: "item/permissions/requestApproval",
      params: {
        threadId: thread.id,
        permissions: { filesystem: { paths: ["/repo/src"] } },
      },
    });

    expect(responses).toEqual([
      { id: "legacy-command", result: { decision: "accept" } },
      {
        id: "scoped-permissions",
        result: {
          permissions: { filesystem: { paths: ["/repo/src"] } },
          scope: "turn",
        },
      },
    ]);
    expect(nextEventSettled).toBe(false);

    serverRequest({
      id: "user-input",
      method: "item/tool/requestUserInput",
      params: {
        threadId: thread.id,
        questions: [{ id: "choice", question: "Which option?", options: null }],
      },
    });
    await expect(nextEvent).resolves.toMatchObject({
      value: {
        type: "ask_user",
        questionId: "native:run-full-access:user-input",
        question: "Which option?",
      },
    });
    await expect(adapter.answerQuestion(
      "native:run-full-access:user-input",
      { answer: "Continue" },
    )).resolves.toBe(true);
    expect(responses.at(-1)).toEqual({
      id: "user-input",
      result: { answers: { choice: { answers: ["Continue"] } } },
    });

    notification({ method: "turn/interrupt", params: { threadId: thread.id, turnId: "turn-full-access" } });
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: "error", code: "NATIVE_PROTOCOL_ERROR" },
    });
  });

  it("answers v2 permission requests with only the requested subset and keeps the turn alive after resolution", async () => {
    const thread = {
      id: "cx-v2-permissions",
      parentThreadId: null,
      preview: "permissions",
      name: "permissions",
      createdAt: 1_788_220_800,
      updatedAt: 1_788_220_800,
      status: { type: "idle" },
      path: null,
      cwd: "/repo",
      source: { custom: "customer-agent" },
      turns: [],
    };
    let notification: (message: any) => void = () => undefined;
    let serverRequest: (message: any) => void = () => undefined;
    let turnStarted = false;
    const responses: Array<{ id: unknown; result: unknown }> = [];
    const resolved: string[] = [];
    const client = {
      onNotification: (handler: typeof notification) => {
        notification = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: (handler: typeof serverRequest) => {
        serverRequest = handler;
      },
      respond: (id: unknown, result: unknown) => {
        responses.push({ id, result });
      },
      respondError: () => undefined,
      request: async (method: string) => {
        if (method === "thread/read" || method === "thread/resume") return { thread };
        if (method === "turn/start") {
          turnStarted = true;
          return { turn: { id: "turn-v2" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
      dispose: async () => undefined,
    };
    const adapter = new CodexRuntimeAdapter({
      client: client as never,
      sessionRoot: "/tmp",
      onApprovalResolved: (questionId) => resolved.push(questionId),
    });
    const iterator = adapter.run(thread.id, "allow scoped access", undefined, undefined, undefined, {
      permissionMode: "request-approval",
      brokerRunId: "run-v2",
    })[Symbol.asyncIterator]();
    const nextQuestion = iterator.next();
    for (let attempt = 0; attempt < 150 && !turnStarted; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(turnStarted).toBe(true);

    serverRequest({
      id: "request-v2",
      method: "item/permissions/requestApproval",
      params: {
        threadId: thread.id,
        permissions: {
          filesystem: { paths: ["/repo/src"] },
          network: { hosts: ["api.example.test"] },
        },
        reason: "Need the requested scoped permissions",
      },
    });
    const question = await nextQuestion;
    expect(question.value).toMatchObject({
      type: "ask_user",
      questionId: "native:run-v2:request-v2",
    });

    await expect(adapter.answerQuestion("native:run-v2:request-v2", { answer: "本会话允许" })).resolves.toBe(true);
    expect(responses).toEqual([{
      id: "request-v2",
      result: {
        permissions: {
          filesystem: { paths: ["/repo/src"] },
          network: { hosts: ["api.example.test"] },
        },
        scope: "session",
      },
    }]);
    expect(responses[0].result).not.toHaveProperty("decision");

    const nextResolvedQuestion = iterator.next();
    serverRequest({
      id: "request-v2-resolved",
      method: "item/permissions/requestApproval",
      params: {
        threadId: thread.id,
        permissions: { filesystem: { paths: ["/repo/read-only"] } },
      },
    });
    await expect(nextResolvedQuestion).resolves.toMatchObject({
      value: { type: "ask_user", questionId: "native:run-v2:request-v2-resolved" },
    });
    notification({ method: "serverRequest/resolved", params: { requestId: "request-v2-resolved" } });
    expect(resolved).toEqual(["native:run-v2:request-v2-resolved"]);

    let secondSettled = false;
    const nextTerminal = iterator.next().then((result) => {
      secondSettled = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(secondSettled).toBe(false);
    notification({ method: "turn/interrupt", params: { threadId: thread.id, turnId: "turn-v2" } });
    await expect(nextTerminal).resolves.toMatchObject({
      value: { type: "error", code: "NATIVE_PROTOCOL_ERROR" },
    });
  });
});

describe("Codex session archive", () => {
  it("archives the native thread through the app-server protocol", async () => {
    const request = vi.fn(async () => ({}));
    const adapter = new CodexRuntimeAdapter({
      client: {
        onNotification: () => () => undefined,
        onExit: () => () => undefined,
        setServerRequestHandler: () => undefined,
        request,
      } as never,
    });

    await expect(adapter.archiveSession("thread-1")).resolves.toBeUndefined();

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith("thread/archive", { threadId: "thread-1" });
  });
});

describe("Codex transcript watch paths", () => {
  it("returns only real transcript files contained by the configured session root", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-watch-root-"));
    const outside = await mkdtemp(join(tmpdir(), "codex-watch-outside-"));
    temporaryDirectories.push(root, outside);
    const transcript = join(root, "2026", "session.jsonl");
    await mkdir(join(root, "2026"));
    await writeFile(transcript, "{}\n");
    const outsideTranscript = join(outside, "session.jsonl");
    await writeFile(outsideTranscript, "{}\n");
    let reportedPath = transcript;
    const client = {
      onNotification: () => () => undefined,
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async () => ({ thread: { path: reportedPath } }),
    };
    const adapter = new CodexRuntimeAdapter({ client: client as never, sessionRoot: root });

    await expect(adapter.getSessionWatchPath("thread-1")).resolves.toBe(await realpath(transcript));
    reportedPath = outsideTranscript;
    await expect(adapter.getSessionWatchPath("thread-1")).resolves.toBeNull();
  });
});

async function drain(iterable: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Codex model & reasoning-effort overrides", () => {
  const baseThread = {
    id: "cx-model",
    parentThreadId: null,
    preview: "model",
    name: "model",
    createdAt: 1_788_220_800,
    updatedAt: 1_788_220_800,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp",
    source: { custom: "customer-agent" },
    turns: [],
  };

  function clientFor(requests: Array<{ method: string; params: any }>) {
    let notify: (message: any) => void = () => undefined;
    return {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "thread/read") return { thread: baseThread };
        if (method === "thread/resume") return { thread: baseThread };
        if (method === "model/list") {
          return {
            data: [
              { id: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", description: "Latest", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "medium" }, { reasoningEffort: "high" }, { reasoningEffort: "xhigh" }] },
              { id: "secret", hidden: true },
              { id: "plain-model" },
            ],
          };
        }
        if (method === "turn/start") {
          queueMicrotask(() => notify({
            method: "turn/completed",
            params: { threadId: baseThread.id, turn: { id: "turn-model", status: "completed", items: [] } },
          }));
          return { turn: { id: "turn-model" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
  }

  it("forwards per-run model and effort onto turn/start", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: clientFor(requests) as never });
    await drain(adapter.run("cx-model", "hi", undefined, undefined, undefined, {
      model: { id: "gpt-5.6-sol" },
      reasoningEffort: "xhigh",
    }));
    const turnStart = requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params.model).toBe("gpt-5.6-sol");
    expect(turnStart?.params.effort).toBe("xhigh");
  });

  it("omits model and effort when the run carries none", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: clientFor(requests) as never });
    await drain(adapter.run("cx-model", "hi"));
    const turnStart = requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params.model).toBeUndefined();
    expect(turnStart?.params.effort).toBeUndefined();
  });

  it("lists connection models with supported reasoning efforts and drops hidden rows", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: clientFor(requests) as never });
    const models = await adapter.listModels();
    expect(requests.find((request) => request.method === "model/list")).toBeTruthy();
    expect(models).toEqual([
      {
        id: "gpt-5.6-sol",
        displayName: "GPT-5.6-Sol",
        description: "Latest",
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
      },
      { id: "plain-model", displayName: "plain-model" },
    ]);
  });
});

describe("Codex occupied-session takeover", () => {
  const occupiedThread = {
    id: "cx-occupied",
    parentThreadId: null,
    preview: "occupied",
    name: "occupied",
    createdAt: 1_788_220_800,
    updatedAt: 1_788_220_800,
    status: { type: "idle" },
    path: "D:\\project\\.codex\\rollout.jsonl",
    cwd: "D:\\project",
    source: "desktop",
    turns: [],
  };

  function buildAdapter(
    requests: Array<{ method: string; params: any }>,
    options: { resumeError?: Error; turnCompleted?: boolean } = {},
  ) {
    let notify: (message: any) => void = () => undefined;
    const client = {
      onNotification: (handler: typeof notify) => {
        notify = handler;
        return () => undefined;
      },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "thread/read") return { thread: occupiedThread };
        if (method === "thread/resume") {
          if (options.resumeError) throw options.resumeError;
          return { thread: occupiedThread };
        }
        if (method === "turn/start") {
          if (options.turnCompleted) {
            queueMicrotask(() => notify({
              method: "turn/completed",
              params: { threadId: occupiedThread.id, turn: { id: "turn-occupied", status: "completed", items: [] } },
            }));
          }
          return { turn: { id: "turn-occupied" } };
        }
        if (method === "thread/unsubscribe") return {};
        throw new Error(`unexpected request: ${method}`);
      },
    };
    return new CodexRuntimeAdapter({
      client: client as never,
      platform: "win32",
      sessionRoot: "C:\\Users\\test\\.codex\\sessions",
      rolloutActivityReader: {
        readMany: async (paths: Iterable<string>) => new Map([...paths].map((path) => [path, "running" as const])),
      },
    });
  }

  it("attempts the takeover even while the rollout is externally occupied", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = buildAdapter(requests, { turnCompleted: true });

    // A stale owned-externally marker must not refuse the run; the app-server
    // writer lock is the authority.
    const events = await drain(adapter.run(occupiedThread.id, "接管试试"));

    expect(requests.map(({ method }) => method)).toEqual([
      "thread/read",
      "thread/resume",
      "turn/start",
      "thread/unsubscribe",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it("explicitly unsubscribes when releasing a session to Codex Desktop", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = buildAdapter(requests);

    await adapter.release(occupiedThread.id);

    expect(requests).toEqual([{
      method: "thread/unsubscribe",
      params: { threadId: occupiedThread.id },
    }]);
  });

  it("surfaces a writer-lock failure as an occupied error event", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = buildAdapter(requests, {
      // The app-server client maps writer-lock responses to this error.
      resumeError: new RuntimeSessionError("Thread is already loaded by another client", "SESSION_OCCUPIED"),
    });

    // Yielded as a terminal event so the UI can offer the manual
    // "以副本继续" recovery flow.
    const events = await drain(adapter.run(occupiedThread.id, "hello"));
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "SESSION_OCCUPIED" })]);
    expect(requests.some(({ method }) => method === "turn/start")).toBe(false);
  });
});

describe("Codex native paged history", () => {
  const turn = (id: string, index: number, withTool = false) => ({
    id,
    status: "completed",
    items: [
      { type: "userMessage", id: `u-${id}`, content: [{ type: "text", text: `q-${id}`, text_elements: [] }] },
      ...(withTool ? [{ type: "commandExecution", id: `call-${id}`, command: "pwd", cwd: "/repo", aggregatedOutput: `out-${id}` }] : []),
      { type: "agentMessage", id: `a-${id}`, text: `s-${id}` },
    ],
  });
  const turns = [
    turn("t1", 1, true),
    turn("t2", 2),
    turn("t3", 3),
    turn("t4", 4, true),
    turn("t5", 5),
  ];
  const baseThread = {
    id: "cx-paged",
    parentThreadId: null,
    preview: "paged",
    name: "paged",
    createdAt: 1_788_220_800,
    updatedAt: 1_788_220_800,
    status: { type: "idle" },
    path: null,
    cwd: "/tmp",
    source: { custom: "customer-agent" },
    turns: [] as any[],
  };

  function pagingClientFor(
    requests: Array<{ method: string; params: any }>,
    opts: {
      failTurnsList?: boolean;
      turnsListErrors?: Error[];
      sourceTurns?: any[];
      threadStatus?: string;
      getThreadStatus?: () => string;
      threadPath?: string;
    } = {},
  ) {
    let notify: (message: any) => void = () => undefined;
    return {
      pid: undefined,
      onNotification: (handler: typeof notify) => { notify = handler; return () => undefined; },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request: async (method: string, params: any) => {
        requests.push({ method, params });
        if (method === "thread/read" && params.includeTurns === false) {
          return {
            thread: {
              ...baseThread,
              path: opts.threadPath ?? baseThread.path,
              status: { type: opts.getThreadStatus?.() ?? opts.threadStatus ?? baseThread.status.type },
            },
          };
        }
        if (method === "thread/turns/list") {
          if (opts.failTurnsList) {
            throw new RuntimeSessionError(
              "unknown method: thread/turns/list",
              "NATIVE_PROTOCOL_ERROR",
            );
          }
          const turnsListError = opts.turnsListErrors?.shift();
          if (turnsListError) throw turnsListError;
          const desc = [...(opts.sourceTurns ?? turns)].reverse();
          if (params.itemsView === "summary") {
            return { data: desc.map((t) => ({ ...t, items: t.items.filter((i: any) => i.type === "userMessage" || i.type === "agentMessage") })) };
          }
          const start = params.cursor ? Number(params.cursor.replace("c", "")) : 0;
          const slice = desc.slice(start, start + (params.limit ?? 5));
          const nextIndex = start + slice.length;
          return { data: slice, nextCursor: nextIndex < desc.length ? `c${nextIndex}` : null };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
  }

  it("serves the latest window without a full thread/read, in rollout order", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests) as never });
    const detail = await adapter.getSessionPaged("cx-paged", { limit: 2 });

    expect(requests.some((r) => r.method === "thread/read" && r.params.includeTurns === true)).toBe(false);
    expect(detail.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual(["q-t5", "s-t5"]);
    expect(detail.history).toMatchObject({ totalItems: 10, pageSize: 2, hasMore: true, kind: "latest", nextCursor: "history.v1.8" });
  });

  it("treats a one-item latest core window as the complete latest turn", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests) as never });

    const detail = await adapter.getSessionPaged("cx-paged", { limit: 1, view: "core" });

    expect(detail.messages.map((message) => message.content)).toEqual(["q-t5", "s-t5"]);
    expect(detail.history).toMatchObject({
      totalItems: 10,
      pageSize: 2,
      hasMore: true,
      nextCursor: "history.v1.8",
      delivery: "core",
    });
    expect(requests.some((request) => (
      request.method === "thread/read" && request.params.includeTurns === true
    ))).toBe(false);
  });

  it("does not expose an unphased running agent summary as a final answer", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const liveTurn = turn("live", 1);
    liveTurn.status = "inProgress";
    liveTurn.items = [
      liveTurn.items[0],
      { type: "agentMessage", id: "commentary-live", text: "正在检查文件" },
    ];
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, {
        sourceTurns: [liveTurn],
        threadStatus: "active",
      }) as never,
    });

    const detail = await adapter.getSessionPaged("cx-paged", { limit: 10, view: "core" });

    expect(detail.messages.map((message) => message.content)).toEqual(["q-live"]);
    expect(detail.history).toMatchObject({ totalItems: 1, pageSize: 1, delivery: "core" });
  });

  it("keeps a durable final answer visible before task_complete reaches native summary history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "codex-finalizing-history-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "rollout.jsonl");
    const liveTurn = turn("live", 1);
    liveTurn.status = "inProgress";
    liveTurn.items = [
      liveTurn.items[0],
      { type: "agentMessage", id: "final-live", text: "durable final" },
    ];
    await writeFile(path, [
      JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "live" } }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          id: "final-live",
          role: "assistant",
          content: [{ type: "output_text", text: "durable final" }],
          phase: "final_answer",
          internal_chat_message_metadata_passthrough: { turn_id: "live" },
        },
      }),
      "",
    ].join("\n"));
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, {
        sourceTurns: [liveTurn],
        threadStatus: "active",
        threadPath: path,
      }) as never,
    });

    const detail = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });

    expect(detail.status).toBe("idle");
    expect(detail.messages.map((message) => message.content)).toEqual(["q-live", "durable final"]);
    expect(detail.history).toMatchObject({ totalItems: 2, pageSize: 2, delivery: "core" });
    expect(requests.filter((request) => request.params.itemsView === "full")).toHaveLength(0);
  });

  it("keeps before-pages contiguous with the latest page", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests) as never });
    const latest = await adapter.getSessionPaged("cx-paged", { limit: 2 });
    const older = await adapter.getSessionPaged("cx-paged", { before: latest.history!.nextCursor!, limit: 2 });

    expect(older.messages.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual(["q-t4", "", "out-t4", "s-t4"]);
    expect(older.history?.pageSize).toBe(2);
    expect(older.history).toMatchObject({ totalItems: 10, pageSize: 2, nextCursor: "history.v1.6", newerCursor: "history.v1.8" });
  });

  it("restores core image attachments without replaying images or changing history identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-core-images-"));
    temporaryDirectories.push(root);
    const pngPath = join(root, "image-1.png");
    const jpegPath = join(root, "image-2.jpg");
    const missingPath = join(root, "missing.png");
    const unsupportedPath = join(root, "unsupported.txt");
    const oversizedPath = join(root, "oversized.png");
    await writeFile(pngPath, "png-image");
    await writeFile(jpegPath, "jpeg-image");
    await writeFile(unsupportedPath, "not-an-image");
    await writeFile(oversizedPath, "");
    await filesystem.truncate(oversizedPath, 20 * 1024 * 1024 + 1);
    const requests: Array<{ method: string; params: any }> = [];
    const sourceTurn = turn("images", 1, true);
    sourceTurn.items[0].content = [
      { type: "text", text: "show images", text_elements: [] },
      { type: "localImage", path: pngPath },
      { type: "local_image", path: jpegPath },
      { type: "localImage", path: missingPath },
      { type: "localImage", path: unsupportedPath },
      { type: "localImage", path: oversizedPath },
    ] as any;
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, { sourceTurns: [sourceTurn] }) as never,
    });

    const core = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    expect(core.messages[0].presentation).toMatchObject({
      executionTrace: { turnId: "images" },
      attachments: [
        { type: "image", name: "image-1.png", dataUrl: `data:image/png;base64,${Buffer.from("png-image").toString("base64")}` },
        { type: "image", name: "image-2.jpg", dataUrl: `data:image/jpeg;base64,${Buffer.from("jpeg-image").toString("base64")}` },
        { type: "image", name: "missing.png", unavailable: true },
        { type: "image", name: "unsupported.txt", unavailable: true },
        { type: "image", name: "oversized.png", unavailable: true },
      ],
    });
    expect(core.messages[0].presentation?.attachments?.[0].unavailable).toBeUndefined();
    expect(core.messages[0].images).toBeUndefined();
    expect(JSON.stringify(core)).not.toContain(root);
    expect(requests.some((request) => request.params.itemsView === "full" || request.params.includeTurns === true)).toBe(false);

    await rm(pngPath);
    const refreshed = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    expect(refreshed.messages[0].presentation?.attachments?.[0]).toEqual({
      type: "image", name: "image-1.png", unavailable: true,
    });
    expect(refreshed.history?.revision).toBe(core.history?.revision);
    expect(refreshed.messages.map((message) => message.historyId)).toEqual(core.messages.map((message) => message.historyId));
  });

  it("reads images only from turns in the selected core page", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-core-image-window-"));
    temporaryDirectories.push(root);
    const sourceTurns = [turn("t1", 1), turn("t2", 2), turn("t3", 3)];
    for (const sourceTurn of sourceTurns) {
      const path = join(root, `${sourceTurn.id}.png`);
      await writeFile(path, sourceTurn.id);
      sourceTurn.items[0].content!.push({ type: "localImage", path } as any);
    }
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests, { sourceTurns }) as never });
    const readImage = vi.spyOn(filesystem, "readFile");
    try {
      const core = await adapter.getSessionPaged("cx-paged", { before: "history.v1.4", limit: 2, view: "core" });
      expect(core.messages.map((message) => message.content)).toEqual(["q-t2", "s-t2"]);
      expect(core.messages[0].presentation?.attachments?.[0].dataUrl).toBe(`data:image/png;base64,${Buffer.from("t2").toString("base64")}`);
      const imageReads = readImage.mock.calls.filter(([path]) => String(path).startsWith(root));
      expect(imageReads).toEqual([[join(root, "t2.png")]]);
      expect(requests.some((request) => request.params.itemsView === "full" || request.params.includeTurns === true)).toBe(false);
    } finally {
      readImage.mockRestore();
    }
  });

  it("inlines newest images within the byte budget and marks older ones as omitted", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-core-image-budget-"));
    temporaryDirectories.push(root);
    const newestPath = join(root, "newest.png");
    const olderPath = join(root, "older.png");
    await writeFile(newestPath, Buffer.alloc(1200, 1));
    await writeFile(olderPath, Buffer.alloc(900, 2));
    const sourceTurns = [turn("old", 1), turn("new", 2, true)];
    sourceTurns[0].items[0].content!.push({ type: "localImage", path: olderPath } as any);
    sourceTurns[1].items[0].content!.push({ type: "localImage", path: newestPath } as any);
    const requests: Array<{ method: string; params: any }> = [];

    // 预算 1.5KB 只够最新一张；更早的降级为 omitted 占位。
    const budgetAdapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, { sourceTurns }) as never,
      coreInlineImageBudgetBytes: 1500,
    });
    const budgeted = await budgetAdapter.getSessionPaged("cx-paged", { limit: 5, view: "core" });
    const byTurn = new Map(budgeted.messages.map((message) => [message.presentation?.executionTrace?.turnId, message]));
    expect(byTurn.get("new")?.presentation?.attachments?.[0]).toMatchObject({ name: "newest.png", dataUrl: expect.any(String) });
    expect(byTurn.get("new")?.presentation?.attachments?.[0].omitted).toBeUndefined();
    expect(byTurn.get("old")?.presentation?.attachments?.[0]).toEqual({ type: "image", name: "older.png", omitted: true });

    // 无图可内联时，允许最新一张突破总预算（单张上限内）以保证可见。
    const tinyBudgetAdapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, { sourceTurns }) as never,
      coreInlineImageBudgetBytes: 10,
    });
    const tiny = await tinyBudgetAdapter.getSessionPaged("cx-paged", { limit: 5, view: "core" });
    const tinyByTurn = new Map(tiny.messages.map((message) => [message.presentation?.executionTrace?.turnId, message]));
    expect(tinyByTurn.get("new")?.presentation?.attachments?.[0]).toMatchObject({ name: "newest.png", dataUrl: expect.any(String) });
    expect(tinyByTurn.get("old")?.presentation?.attachments?.[0]).toEqual({ type: "image", name: "older.png", omitted: true });
  });

  it("loads core without hydration, then exposes trace results through lazy locators", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests) as never });
    const query = { before: "history.v1.8", limit: 2 };

    const core = await adapter.getSessionPaged("cx-paged", { ...query, view: "core" });
    expect(core.messages.map((message) => message.content)).toEqual(["q-t4", "s-t4"]);
    expect(core.messages[0].presentation?.executionTrace).toEqual({ turnId: "t4" });
    expect(requests.filter((request) => request.params.itemsView === "full")).toHaveLength(0);

    const trace = await adapter.getSessionPaged("cx-paged", {
      ...query,
      view: "trace",
      revision: core.history?.revision,
    });
    const toolMessage = trace.messages.find((message) => message.role === "tool");
    expect(toolMessage).toMatchObject({
      content: "",
      toolCallId: "call-t4",
      toolResultRef: {
        turnId: "t4",
        itemId: "call-t4",
        revision: core.history?.revision,
        byteSize: 6,
      },
    });
    expect(JSON.stringify(trace)).not.toContain("out-t4");

    await expect(adapter.getSessionToolResult("cx-paged", toolMessage!.toolResultRef!)).resolves.toMatchObject({
      itemId: "call-t4",
      content: "out-t4",
      byteSize: 6,
    });
  });

  it("hydrates only the selected turn for an on-demand execution trace", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests) as never });
    const core = await adapter.getSessionPaged("cx-paged", { limit: 10, view: "core" });

    const trace = await adapter.getSessionPaged("cx-paged", {
      view: "trace",
      revision: core.history?.revision,
      turnId: "t4",
    });

    expect(trace.messages.some((message) => message.role === "user")).toBe(false);
    expect(trace.messages.some((message) => message.content === "s-t4")).toBe(false);
    expect(trace.messages.find((message) => message.role === "tool")?.toolResultRef)
      .toMatchObject({ turnId: "t4", itemId: "call-t4" });
    expect(requests.filter((request) => request.params.itemsView === "full")).toHaveLength(1);
  });

  it("returns commentary in the trace without adding it to core pagination", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const directory = await mkdtemp(join(tmpdir(), "codex-commentary-history-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "rollout.jsonl");
    const commentary = (id: string, text: string) => JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id,
        role: "assistant",
        content: [{ type: "output_text", text }],
        phase: "commentary",
        internal_chat_message_metadata_passthrough: { turn_id: "phased" },
      },
    });
    await writeFile(path, `${commentary("commentary-phased", "正在读取项目")}\n`);
    const phasedTurn = turn("phased", 1) as any;
    phasedTurn.items = [
      phasedTurn.items[0],
      { type: "agentMessage", id: "commentary-phased", text: "正在读取项目" },
      { type: "commandExecution", id: "call-phased", command: "pwd", cwd: "/repo", aggregatedOutput: "/repo" },
      { type: "agentMessage", id: "answer-phased", text: "读取完成", phase: "final_answer" },
    ];
    const rolloutCommentaryReader = new CodexRolloutCommentaryReader();
    const commentaryRead = vi.spyOn(rolloutCommentaryReader, "read");
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, { sourceTurns: [phasedTurn], threadPath: path }) as never,
      rolloutCommentaryReader,
    });

    const core = await adapter.getSessionPaged("cx-paged", { limit: 10, view: "core" });
    expect(core.messages.map((message) => message.content)).toEqual(["q-phased", "读取完成"]);
    expect(core.history).toMatchObject({ totalItems: 2, pageSize: 2 });
    expect(commentaryRead).not.toHaveBeenCalled();

    await appendFile(path, `${commentary("commentary-phased-2", "正在读取项目和依赖")}\n`);
    const refreshedCore = await adapter.getSessionPaged("cx-paged", { limit: 10, view: "core" });
    expect(refreshedCore.history?.revision).toBe(core.history?.revision);
    expect(refreshedCore.history).toMatchObject({ totalItems: 2, pageSize: 2 });
    expect(commentaryRead).not.toHaveBeenCalled();

    const trace = await adapter.getSessionPaged("cx-paged", {
      view: "trace",
      revision: core.history?.revision,
      turnId: "phased",
    });
    expect(trace.messages.filter((message) => message.presentation?.agentMessagePhase === "commentary")
      .map((message) => message.content)).toEqual(["正在读取项目", "正在读取项目和依赖"]);
    expect(trace.messages.some((message) => message.content === "读取完成")).toBe(false);
    expect(commentaryRead).toHaveBeenCalledOnce();
  });

  it("rejects an unknown on-demand trace turn", async () => {
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor([]) as never });
    const core = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });

    await expect(adapter.getSessionPaged("cx-paged", {
      view: "trace",
      revision: core.history?.revision,
      turnId: "missing",
    })).rejects.toMatchObject({ code: "STALE_SESSION_ANCHOR" });
  });

  it("refreshes a cached running tail turn as its streamed text grows", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const liveTurns = [turn("live", 1)];
    liveTurns[0].status = "inProgress";
    (liveTurns[0].items.at(-1) as { text: string }).text = "partial";
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, { sourceTurns: liveTurns, threadStatus: "active" }) as never,
    });

    const firstCore = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    const firstTrace = await adapter.getSessionPaged("cx-paged", {
      limit: 2,
      view: "trace",
      revision: firstCore.history?.revision,
    });
    expect(firstTrace.messages.at(-1)?.content).toBe("partial");

    (liveTurns[0].items.at(-1) as { text: string }).text = "partial response keeps growing";
    const secondCore = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    const secondTrace = await adapter.getSessionPaged("cx-paged", {
      limit: 2,
      view: "trace",
      revision: secondCore.history?.revision,
    });

    expect(secondTrace.messages.at(-1)?.content).toBe("partial response keeps growing");
    expect(requests.filter((request) => request.params.itemsView === "full")).toHaveLength(2);
  });

  it("keeps visible running text when a later native snapshot temporarily contains only tools", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const liveTurns = [turn("live", 1)];
    liveTurns[0].status = "inProgress";
    (liveTurns[0].items.at(-1) as { text: string }).text = "visible progress";
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, { sourceTurns: liveTurns, threadStatus: "active" }) as never,
    });

    const firstCore = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    await adapter.getSessionPaged("cx-paged", {
      limit: 2,
      view: "trace",
      revision: firstCore.history?.revision,
    });
    liveTurns[0].items = [
      liveTurns[0].items[0],
      { type: "commandExecution", id: "call-live", command: "pwd", cwd: "/repo", aggregatedOutput: "/repo" },
    ];

    const secondCore = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    const secondTrace = await adapter.getSessionPaged("cx-paged", {
      limit: 2,
      view: "trace",
      revision: secondCore.history?.revision,
    });

    expect(secondTrace.messages.some((message) => message.content === "visible progress")).toBe(true);
    expect(secondTrace.messages.some((message) => message.toolCalls?.[0]?.id === "call-live")).toBe(true);
  });

  it("refreshes the tail once more after a running turn completes", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const liveTurns = [turn("live", 1)];
    let threadStatus = "active";
    liveTurns[0].status = "inProgress";
    (liveTurns[0].items.at(-1) as { text: string }).text = "partial";
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, {
        sourceTurns: liveTurns,
        getThreadStatus: () => threadStatus,
      }) as never,
    });

    const runningCore = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    await adapter.getSessionPaged("cx-paged", {
      limit: 2,
      view: "trace",
      revision: runningCore.history?.revision,
    });

    threadStatus = "idle";
    liveTurns[0].status = "completed";
    (liveTurns[0].items.at(-1) as { text: string }).text = "final answer";
    const completedCore = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    const completedTrace = await adapter.getSessionPaged("cx-paged", {
      limit: 2,
      view: "trace",
      revision: completedCore.history?.revision,
    });

    expect(completedTrace.messages.at(-1)?.content).toBe("final answer");
    expect(requests.filter((request) => request.params.itemsView === "full")).toHaveLength(2);
  });

  it("finishes a cached previous turn after the next queued turn has already started", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const liveTurns = [turn("previous", 1, true)];
    liveTurns[0].status = "inProgress";
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, { sourceTurns: liveTurns, threadStatus: "active" }) as never,
    });
    const initialCore = await adapter.getSessionPaged("cx-paged", { view: "core" });
    await adapter.getSessionPaged("cx-paged", {
      view: "trace", turnId: "previous", revision: initialCore.history?.revision,
    });

    liveTurns[0] = {
      ...liveTurns[0], status: "completed",
      items: [...liveTurns[0].items, {
        type: "commandExecution", id: "late-write", command: "write output", cwd: "/repo", aggregatedOutput: "saved",
      }],
    };
    liveTurns.push({ ...turn("next", 2), status: "inProgress" });
    const core = await adapter.getSessionPaged("cx-paged", { view: "core" });
    const query = { view: "trace" as const, turnId: "previous", revision: core.history?.revision };
    const trace = await adapter.getSessionPaged("cx-paged", query);
    expect(trace.messages.flatMap((message) => message.toolCalls ?? []).map((call) => call.id))
      .toEqual(["call-previous", "late-write"]);
    const fullReads = requests.filter(({ params }) => params.itemsView === "full").length;
    await adapter.getSessionPaged("cx-paged", query);
    expect(requests.filter(({ params }) => params.itemsView === "full")).toHaveLength(fullReads);
  });

  it("excludes async questions from core even with a final_answer phase", async () => {
    const sourceTurns = [{
      ...turn("questions", 1),
      items: [
        turn("questions", 1).items[0],
        { type: "agentMessage", id: "async", text: "Choose one", phase: "final_answer", delivery: "async" },
        { type: "agentMessage", id: "final", text: "Actual final" },
      ],
    }];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor([], { sourceTurns }) as never });
    const core = await adapter.getSessionPaged("cx-paged", { view: "core" });
    expect(core.messages.map((message) => message.content)).toEqual(["q-questions", "Actual final"]);
    expect(core.history?.totalItems).toBe(2);
  });

  it("rejects trace and lazy-result reads from a stale revision", async () => {
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor([]) as never });

    await expect(adapter.getSessionPaged("cx-paged", {
      limit: 2,
      view: "trace",
      revision: "stale",
    })).rejects.toMatchObject({ code: "STALE_SESSION_ANCHOR" });
    await expect(adapter.getSessionToolResult("cx-paged", {
      turnId: "t4",
      itemId: "call-t4",
      revision: "stale",
    })).rejects.toMatchObject({ code: "STALE_SESSION_ANCHOR" });
  });

  it("serves anchors from the query index in the same ordinal space", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests) as never });
    const index = await adapter.getQueryIndex("cx-paged");
    expect(index?.entries).toHaveLength(5);
    const target = index!.entries[3];

    const detail = await adapter.getSessionPaged("cx-paged", { anchor: target.pageToken, limit: 2 });
    expect(detail.history?.kind).toBe("anchored");
    expect(detail.history?.revision).toBe(index!.revision);
    expect(detail.messages.some((m) => m.content === "q-t4")).toBe(true);
  });

  it("navigates one complete core turn without hydrating unrelated history", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests) as never });
    const index = await adapter.getQueryIndex("cx-paged");
    const page = await adapter.getSessionPaged("cx-paged", {
      anchor: index!.entries[2].pageToken, limit: 1, view: "core",
    });
    expect(page.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["q-t3"]);
    expect(page.messages.some((message) => message.role === "assistant")).toBe(true);
    expect(page.history?.olderCursor).toBeTruthy();
    expect(page.history?.newerCursor).toBeTruthy();
    const older = await adapter.getSessionPaged("cx-paged", {
      before: page.history!.olderCursor!, limit: 1, view: "core",
    });
    const newer = await adapter.getSessionPaged("cx-paged", {
      after: page.history!.newerCursor!, limit: 1, view: "core",
    });
    expect(older.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["q-t2"]);
    expect(newer.messages.filter((message) => message.role === "user").map((message) => message.content)).toEqual(["q-t4"]);
    expect(requests.some(({ params }) => params.itemsView === "full" || params.includeTurns === true)).toBe(false);
  });

  it("degrades permanently when the protocol method is missing", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({ client: pagingClientFor(requests, { failTurnsList: true }) as never });
    await expect(adapter.getSessionPaged("cx-paged", { limit: 2 })).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(await adapter.getQueryIndex("cx-paged")).toBeNull();
    const seen = requests.length;
    await expect(adapter.getSessionPaged("cx-paged", { limit: 2 })).rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });
    expect(requests.length).toBe(seen);
  });

  it("falls back only for the current request after a session-level paging error", async () => {
    const requests: Array<{ method: string; params: any }> = [];
    const adapter = new CodexRuntimeAdapter({
      client: pagingClientFor(requests, {
        turnsListErrors: [new RuntimeSessionError(
          "Invalid request (-32602): thread not loaded: unavailable-session",
          "NATIVE_PROTOCOL_ERROR",
        )],
      }) as never,
    });

    await expect(adapter.getSessionPaged("unavailable-session", { limit: 2, view: "core" }))
      .rejects.toMatchObject({ code: "OPERATION_NOT_SUPPORTED" });

    const detail = await adapter.getSessionPaged("cx-paged", { limit: 2, view: "core" });
    expect(detail.history).toMatchObject({ delivery: "core", pageSize: 2 });
    expect(requests.filter((request) => request.method === "thread/turns/list")).toHaveLength(2);
  });
});
