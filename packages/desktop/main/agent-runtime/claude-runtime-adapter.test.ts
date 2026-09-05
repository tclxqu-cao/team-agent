import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeRuntimeAdapter,
  ClaudeSubagentTracker,
  classifyClaudePermission,
  claudeHistoryToMessages,
  claudeSdkMessageToEvents,
  requiresClaudeApproval,
} from "./claude-runtime-adapter.js";

const state = vi.hoisted(() => ({
  sessions: [] as any[],
  messages: [] as any[],
  stream: [] as any[],
  queryCalls: [] as any[],
  inputMessages: [] as any[],
  closedQueries: 0,
  interrupted: 0,
  openFiles: [] as string[],
  agentRecords: [] as any[],
  versionStdout: "claude 2.1.250",
  versionFails: false,
  triggerPermission: false,
  permissionResult: null as any,
  signal: undefined as AbortSignal | undefined,
  subagentIds: [] as string[],
  subagentMessages: {} as Record<string, any[]>,
}));

const temporaryDirectories: string[] = [];

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (options: any) => {
    state.queryCalls.push(options);
    if (typeof options.prompt === "string") {
      state.inputMessages.push(options.prompt);
    } else {
      void (async () => {
        for await (const message of options.prompt) state.inputMessages.push(message);
      })();
    }
    const canUseTool = options.options?.canUseTool as
      | ((tool: string, input: any, meta: any) => any)
      | undefined;
    let closed = false;
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const message of state.stream) {
          if (closed) return;
          yield message;
          if (canUseTool && state.triggerPermission) {
            state.triggerPermission = false;
            state.permissionResult = canUseTool("Bash", { command: "pwd" }, {
              signal: state.signal ?? new AbortController().signal,
              suggestions: [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }],
              requestId: "req-1",
              title: "运行命令",
              description: "pwd",
              decisionReason: "需要执行 Bash",
            });
            // The real SDK blocks the stream until canUseTool settles, so mirror
            // that here; otherwise the run loop drains and breaks immediately.
            await state.permissionResult;
          }
        }
      },
      interrupt: async () => {
        state.interrupted += 1;
      },
      close: () => {
        closed = true;
        state.closedQueries += 1;
      },
    };
  },
  listSessions: async (params: any = {}) => {
    const limit = params.limit ?? 200;
    const offset = params.offset ?? 0;
    return state.sessions.slice(offset, offset + limit);
  },
  getSessionMessages: async () => state.messages,
  listSubagents: async () => state.subagentIds,
  getSubagentMessages: async (_sessionId: string, agentId: string) => state.subagentMessages[agentId] ?? [],
}));

vi.mock("./native-processes.js", () => ({
  listOpenSessionFiles: async () => state.openFiles,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const stdoutFor = (args: string[]) =>
    args.includes("agents") ? JSON.stringify(state.agentRecords) : state.versionStdout;
  // node's execFile ships a promisify.custom, and the generic promisify wrapper
  // only resolves the first callback value, so provide the custom path explicitly.
  const execFileMock: any = (...args: any[]) => {
    const done = args.find((arg) => typeof arg === "function");
    if (!done) return;
    if (state.versionFails) {
      done(new Error("spawn claude ENOENT"));
      return;
    }
    done(null, stdoutFor(args[1]), "");
  };
  execFileMock[Symbol.for("nodejs.util.promisify.custom")] = async (_file: string, args: string[]) => {
    if (state.versionFails) throw new Error("spawn claude ENOENT");
    return { stdout: stdoutFor(args), stderr: "" };
  };
  return { ...actual, execFile: execFileMock };
});

function sdkSession(id: string, overrides: Record<string, unknown> = {}): any {
  return {
    sessionId: id,
    summary: `summary ${id}`,
    customTitle: undefined,
    firstPrompt: undefined,
    cwd: "/repo",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastModified: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  state.sessions = [];
  state.messages = [];
  state.stream = [];
  state.queryCalls = [];
  state.inputMessages = [];
  state.closedQueries = 0;
  state.interrupted = 0;
  state.openFiles = [];
  state.agentRecords = [];
  state.versionStdout = "claude 2.1.250";
  state.versionFails = false;
  state.triggerPermission = false;
  state.permissionResult = null;
  state.signal = undefined;
  state.subagentIds = [];
  state.subagentMessages = {};
});

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Claude history mapping", () => {
  it("maps text, tool calls, and tool results without copying system records", () => {
    const history = [
      { type: "system", message: { content: "hidden" } },
      { type: "user", message: { content: "inspect" } },
      {
        type: "assistant",
        message: { content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/a" } },
        ] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "contents" }] },
      },
    ] as SessionMessage[];

    expect(claudeHistoryToMessages(history)).toEqual([
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: "working",
        toolCalls: [{ id: "tool-1", name: "Read", arguments: { file_path: "/tmp/a" } }],
      },
      { role: "tool", content: "contents", toolCallId: "tool-1" },
    ]);
  });

  it("skips assistant entries that carry neither text nor tool calls", () => {
    const history = [
      { type: "assistant", message: { content: [] } },
      { type: "assistant", message: { content: [{ type: "thinking", thinking: "..." }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tool-9", content: "" }] } },
    ] as SessionMessage[];

    expect(claudeHistoryToMessages(history)).toEqual([
      { role: "tool", content: "", toolCallId: "tool-9" },
    ]);
  });

  it("accepts plain string content and joins multiple text blocks", () => {
    const history = [
      { type: "user", message: { content: "plain question" } },
      { type: "assistant", message: { content: [{ type: "text", text: "first" }, { type: "text", text: "second" }] } },
    ] as SessionMessage[];

    expect(claudeHistoryToMessages(history)).toEqual([
      { role: "user", content: "plain question" },
      { role: "assistant", content: "first\nsecond" },
    ]);
  });

  it("restores base64 image blocks from user history", () => {
    const history = [{
      type: "user",
      message: {
        content: [
          { type: "text", text: "inspect" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      },
    }] as SessionMessage[];

    expect(claudeHistoryToMessages(history)).toEqual([{
      role: "user",
      content: "inspect",
      presentation: {
        attachments: [{
          type: "image",
          name: "image-1.png",
          dataUrl: "data:image/png;base64,iVBORw0KGgo=",
        }],
      },
    }]);
  });

  it("keeps error tool results as tool messages", () => {
    const history = [
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tool-1", content: "command failed", is_error: true }] },
      },
    ] as SessionMessage[];

    expect(claudeHistoryToMessages(history)).toEqual([
      { role: "tool", content: "command failed", toolCallId: "tool-1" },
    ]);
  });
});

describe("Claude SDK event mapping", () => {
  it("maps allowlisted public progress without exposing private thinking", () => {
    expect(claudeSdkMessageToEvents({
      type: "system", subtype: "thinking_tokens", estimated_tokens: 1234,
    } as SDKMessage, false)).toEqual([{
      type: "runtime_progress",
      progressId: "claude:thinking",
      phase: "thinking",
      label: "正在思考",
      current: 1234,
      detail: "1,234 tokens",
    }]);
    expect(claudeSdkMessageToEvents({
      type: "tool_progress", tool_use_id: "tool-1", tool_name: "Bash", elapsed_time_seconds: 2.4,
    } as SDKMessage, false)).toEqual([expect.objectContaining({
      type: "runtime_progress",
      progressId: "claude:tool:tool-1",
      phase: "tool",
      toolCallId: "tool-1",
      elapsedSeconds: 2.4,
    })]);
    expect(claudeSdkMessageToEvents({
      type: "system", subtype: "api_retry", attempt: 2, max_retries: 4,
    } as SDKMessage, false)).toEqual([expect.objectContaining({
      type: "runtime_progress", phase: "retry", current: 2, total: 4,
    })]);
    expect(claudeSdkMessageToEvents({
      type: "system", subtype: "informational", content: "正在读取项目",
    } as SDKMessage, false)).toEqual([expect.objectContaining({
      type: "runtime_progress", phase: "status", label: "正在读取项目",
    })]);

    expect(claudeSdkMessageToEvents({
      type: "assistant", message: { content: [{ type: "thinking", thinking: "private reasoning" }] },
    } as SDKMessage, false)).toEqual([]);
    expect(claudeSdkMessageToEvents({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "private delta" } },
    } as SDKMessage, false)).toEqual([]);
  });

  it("maps partial text and completed tool blocks to agent events", () => {
    const partial = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    } as SDKMessage;
    const assistant = {
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "pwd" } }] },
    } as SDKMessage;

    expect(claudeSdkMessageToEvents(partial, false)).toEqual([{ type: "text_chunk", text: "hello" }]);
    expect(claudeSdkMessageToEvents(assistant, true)).toEqual([
      { type: "tool_call", toolCall: { id: "t1", name: "Bash", arguments: { command: "pwd" } } },
    ]);
  });

  it("ignores non-text stream deltas", () => {
    const delta = {
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } },
    } as SDKMessage;

    expect(claudeSdkMessageToEvents(delta, false)).toEqual([]);
  });

  it("emits assistant text only when nothing has streamed yet", () => {
    const assistant = {
      type: "assistant",
      message: { content: [{ type: "text", text: "final answer" }] },
    } as SDKMessage;

    expect(claudeSdkMessageToEvents(assistant, false)).toEqual([{ type: "text_chunk", text: "final answer" }]);
    expect(claudeSdkMessageToEvents(assistant, true)).toEqual([]);
  });

  it("maps user tool results and preserves error flags", () => {
    const user = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "boom", is_error: true }] },
    } as SDKMessage;

    expect(claudeSdkMessageToEvents(user, false)).toEqual([
      { type: "tool_result", result: { toolCallId: "t2", content: "boom", isError: true } },
    ]);
  });

  it("returns nothing for result, system, and non-array user content", () => {
    expect(claudeSdkMessageToEvents({ type: "result", subtype: "success" } as SDKMessage, false)).toEqual([]);
    expect(claudeSdkMessageToEvents({ type: "system", subtype: "init" } as SDKMessage, false)).toEqual([]);
    expect(claudeSdkMessageToEvents({ type: "user", message: { content: "plain" } } as SDKMessage, false)).toEqual([]);
  });

  it("keeps child frames out of the parent timeline", () => {
    expect(claudeSdkMessageToEvents({
      type: "stream_event",
      parent_tool_use_id: "agent-tool",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "child output" } },
    } as SDKMessage, false)).toEqual([]);
    expect(claudeSdkMessageToEvents({
      type: "assistant",
      parent_tool_use_id: "agent-tool",
      message: { content: [{ type: "thinking", thinking: "private" }, { type: "text", text: "public" }] },
    } as SDKMessage, false)).toEqual([]);
  });
});

describe("ClaudeSubagentTracker", () => {
  it("projects public child text, tool calls, results, and progress without thinking", () => {
    const tracker = new ClaudeSubagentTracker();
    const events = [
      ...tracker.consume({
        type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "agent-tool",
        task_type: "local_agent", subagent_type: "Explore", description: "Inspect files", is_backgrounded: true,
      } as SDKMessage),
      ...tracker.consume({
        type: "assistant", parent_tool_use_id: "agent-tool", message: { content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Reading source" },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "a.ts" } },
        ] },
      } as SDKMessage),
      ...tracker.consume({
        type: "user", parent_tool_use_id: "agent-tool", message: { content: [
          { type: "tool_result", tool_use_id: "read-1", content: "source", is_error: false },
        ] },
      } as SDKMessage),
      ...tracker.consume({
        type: "system", subtype: "task_progress", task_id: "task-1", description: "Inspect files",
        subagent_type: "Explore", summary: "Found entry point", last_tool_name: "Read",
        usage: { total_tokens: 10, tool_uses: 1, duration_ms: 2400 },
      } as SDKMessage),
    ];

    const lastEvent = events.at(-1);
    const activity = lastEvent?.type === "native_subagent_update" ? lastEvent.activity : null;
    expect(activity).toMatchObject({
      parentToolCallId: "agent-tool",
      status: "running",
      summary: "Found entry point",
      lastToolName: "Read",
      elapsedSeconds: 2,
      toolUses: 1,
    });
    expect(activity?.messages).toEqual([
      { role: "assistant", content: "Reading source", toolCalls: [{ id: "read-1", name: "Read", arguments: { file_path: "a.ts" } }] },
      { role: "tool", content: "source", toolCallId: "read-1" },
    ]);
    expect(JSON.stringify(events)).not.toContain("private reasoning");
    expect(tracker.hasActiveBackgroundTasks()).toBe(true);
  });

  it("isolates concurrent parents and ignores ambient tasks", () => {
    const tracker = new ClaudeSubagentTracker();
    expect(tracker.consume({
      type: "system", subtype: "task_started", task_id: "ambient", tool_use_id: "hidden",
      task_type: "local_agent", description: "watch", is_backgrounded: true, ambient: true,
    } as SDKMessage)).toEqual([]);
    tracker.consume({
      type: "system", subtype: "task_started", task_id: "one", tool_use_id: "parent-one",
      task_type: "local_agent", description: "one", is_backgrounded: true,
    } as SDKMessage);
    tracker.consume({
      type: "system", subtype: "task_started", task_id: "two", tool_use_id: "parent-two",
      task_type: "local_agent", description: "two", is_backgrounded: true,
    } as SDKMessage);

    const [update] = tracker.consume({
      type: "assistant", parent_tool_use_id: "parent-two", message: { content: [{ type: "text", text: "second" }] },
    } as SDKMessage);
    expect(update.type === "native_subagent_update" && update.activity.parentToolCallId).toBe("parent-two");
  });
});

describe("ClaudeRuntimeAdapter", () => {
  it("finds only a direct project transcript for a UUID session", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-watch-root-"));
    temporaryDirectories.push(root);
    const sessionId = "123e4567-e89b-42d3-a456-426614174000";
    const project = join(root, "-repo");
    await mkdir(join(project, "subagents"), { recursive: true });
    await writeFile(join(project, "subagents", `${sessionId}.jsonl`), "{}\n");
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: root });

    await expect(adapter.getSessionWatchPath(sessionId)).resolves.toBeNull();
    const transcript = join(project, `${sessionId}.jsonl`);
    await writeFile(transcript, "{}\n");
    await expect(adapter.getSessionWatchPath(sessionId)).resolves.toBe(transcript);
    await expect(adapter.getSessionWatchPath("../unsafe")).resolves.toBeNull();
  });

  it("recovers public subagent history beside a visible Agent tool call", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-subagent-history-"));
    temporaryDirectories.push(root);
    const sessionId = "123e4567-e89b-42d3-a456-426614174001";
    const project = join(root, "-repo");
    const subagents = join(project, sessionId, "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(join(project, `${sessionId}.jsonl`), "{}\n");
    await writeFile(join(subagents, "agent-child-1.meta.json"), JSON.stringify({
      agentType: "Explore",
      description: "Trace the runtime",
      toolUseId: "agent-tool",
      spawnDepth: 1,
    }));
    await writeFile(join(subagents, "agent-malformed.meta.json"), "not json");
    state.sessions = [sdkSession(sessionId)];
    state.messages = [{
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { prompt: "trace" } }] },
    }];
    state.subagentIds = ["child-1", "malformed", "missing"];
    state.subagentMessages = {
      "child-1": [
        { type: "assistant", message: { content: [{ type: "thinking", thinking: "secret" }] } },
        { type: "assistant", message: { content: [
          { type: "text", text: "Found the cause" },
          { type: "tool_use", id: "read-1", name: "Read", input: { file_path: "runtime.ts" } },
        ] } },
        { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-1", content: "source" }] } },
      ],
    };
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: root });

    const detail = await adapter.getSession(sessionId);

    expect(detail.events).toEqual([{
      type: "native_subagent_update",
      activity: expect.objectContaining({
        taskId: "child-1",
        parentToolCallId: "agent-tool",
        agentName: "Explore",
        description: "Trace the runtime",
        status: "completed",
        summary: "Found the cause",
      }),
    }]);
    expect(JSON.stringify(detail.events)).not.toContain("secret");
    expect(detail.events[0]).toMatchObject({
      activity: { messages: [
        { role: "assistant", content: "Found the cause", toolCalls: [{ id: "read-1", name: "Read" }] },
        { role: "tool", content: "source", toolCallId: "read-1" },
      ] },
    });
  });

  it("reports health with the CLI version and degrades when the CLI is missing", async () => {
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await expect(adapter.health()).resolves.toEqual({
      agentType: "claude-code",
      available: true,
      label: "Claude Code",
      version: "claude 2.1.250",
    });

    state.versionFails = true;
    const unhealthy = await adapter.health();
    expect(unhealthy.available).toBe(false);
    expect(unhealthy.error).toContain("ENOENT");
  });

  it("marks sessions held by other processes as externally owned and read-only", async () => {
    state.sessions = [sdkSession("cc-1"), sdkSession("cc-2")];
    state.openFiles = ["/root/proj/cc-1.jsonl"];
    state.agentRecords = [{ sessionId: "cc-2", state: "working", status: "active" }];

    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const sessions = await adapter.discoverSessions();

    expect(sessions.find((session) => session.nativeSessionId === "cc-1")?.occupancy).toBe("owned-externally");
    expect(sessions.find((session) => session.nativeSessionId === "cc-1")?.canResume).toBe(false);
    expect(sessions.find((session) => session.nativeSessionId === "cc-2")?.occupancy).toBe("owned-externally");
    expect(sessions.every((session) => session.canDelete === false)).toBe(true);
  });

  it("leaves finished agent records and untouched sessions available", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.agentRecords = [{ sessionId: "cc-1", state: "done", status: "completed" }];

    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const [session] = await adapter.discoverSessions();

    expect(session.occupancy).toBe("available");
    expect(session.canResume).toBe(true);
    expect(session.status).toBe("idle");
  });

  it("pages through the native session index", async () => {
    state.sessions = Array.from({ length: 250 }, (_, index) => sdkSession(`cc-${index}`));

    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const sessions = await adapter.discoverSessions();

    expect(sessions).toHaveLength(250);

    const target = state.sessions[220];
    const detail = await adapter.getSession(target.sessionId);
    expect(detail.nativeSessionId).toBe("cc-220");
  });

  it("prefers custom titles and falls back through summary to first prompt", async () => {
    state.sessions = [
      sdkSession("cc-1", { customTitle: "重构会话服务" }),
      sdkSession("cc-2", { customTitle: undefined, summary: undefined, firstPrompt: "帮我看一下这个报错" }),
      sdkSession("cc-3", { customTitle: undefined, summary: undefined, firstPrompt: undefined }),
    ];

    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const titles = (await adapter.discoverSessions()).map((session) => session.title).sort();

    expect(titles).toEqual(["Claude Code session", "帮我看一下这个报错", "重构会话服务"]);
  });

  it("recovers a missing SDK cwd from the native transcript without failing on malformed JSONL", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-session-cwd-"));
    temporaryDirectories.push(root);
    const project = join(root, "-repo");
    await mkdir(project, { recursive: true });
    const recoveredId = "123e4567-e89b-42d3-a456-426614174010";
    const malformedId = "123e4567-e89b-42d3-a456-426614174011";
    await writeFile(
      join(project, `${recoveredId}.jsonl`),
      `${JSON.stringify({ type: "user", payload: "x".repeat(300 * 1024), cwd: "/repo/from-transcript" })}\n`,
    );
    await writeFile(join(project, `${malformedId}.jsonl`), "{not-json}\n");
    state.sessions = [
      sdkSession(recoveredId, { cwd: "" }),
      sdkSession(malformedId, { cwd: "" }),
    ];

    const sessions = await new ClaudeRuntimeAdapter({ sessionRoot: root }).discoverSessions();

    expect(sessions.find((session) => session.nativeSessionId === recoveredId)?.cwd)
      .toBe("/repo/from-transcript");
    expect(sessions.find((session) => session.nativeSessionId === malformedId)?.cwd).toBe("");
  });

  it("keeps newly created drafts visible before the native index catches up", async () => {
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const created = await adapter.create({ title: "新会话", cwd: "/repo" });

    expect(created.agentType).toBe("claude-code");
    expect(created.canDelete).toBe(false);
    expect(created.id).not.toBe(created.nativeSessionId);

    const detail = await adapter.getSession(created.nativeSessionId);
    expect(detail.title).toBe("新会话");
    expect((await adapter.discoverSessions()).map((session) => session.nativeSessionId))
      .toContain(created.nativeSessionId);
  });

  it("restores a persisted draft with the same native session id", async () => {
    const original = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const created = await original.create({ title: "持久草稿", cwd: "/repo" });
    const restored = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    restored.restoreDraft(created);
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];

    await expect(restored.getSession(created.nativeSessionId)).resolves.toMatchObject({
      id: created.id,
      title: "持久草稿",
      cwd: "/repo",
    });
    await drain(restored.run(created.nativeSessionId, "start after restart"));
    expect(state.queryCalls[0].options).toMatchObject({ sessionId: created.nativeSessionId, cwd: "/repo" });
  });

  it("throws SESSION_NOT_FOUND for unknown native sessions", async () => {
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await expect(adapter.getSession("missing")).rejects.toMatchObject({
      name: "RuntimeSessionError",
      code: "SESSION_NOT_FOUND",
    });
  });

  it("resumes an existing session and seeds a draft with an explicit session id", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await drain(adapter.run("cc-1", "continue"));
    expect(state.queryCalls[0].options).toMatchObject({ resume: "cc-1", cwd: "/repo" });
    expect(state.queryCalls[0].options).not.toHaveProperty("sessionId");

    const created = await adapter.create({ title: "fresh", cwd: "/repo" });
    await drain(adapter.run(created.nativeSessionId, "start"));
    expect(state.queryCalls[1].options).toMatchObject({ sessionId: created.nativeSessionId });
    expect(state.queryCalls[1].options).not.toHaveProperty("resume");
  });

  it("uses Claude Code native goal input and enables SDK skills", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await drain(adapter.run("cc-1", "ignored", undefined, undefined, undefined, {
      goal: { id: "goal-1", objective: "finish the migration" },
    }));

    expect(state.queryCalls[0].options.skills).toBe("all");
    expect(state.inputMessages[0]).toMatchObject({
      type: "user",
      message: { content: "/goal finish the migration" },
    });
  });

  it("refuses to run a session that another client owns", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.openFiles = ["/root/proj/cc-1.jsonl"];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await expect(drain(adapter.run("cc-1", "hello"))).rejects.toMatchObject({
      name: "RuntimeSessionError",
      code: "SESSION_OCCUPIED",
    });
    expect(state.queryCalls).toHaveLength(0);
  });

  it("refuses concurrent runs of the same session", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    const first = adapter.run("cc-1", "first")[Symbol.asyncIterator]();
    await first.next();

    await expect(drain(adapter.run("cc-1", "second"))).rejects.toMatchObject({
      name: "RuntimeSessionError",
      code: "SESSION_ALREADY_RUNNING",
    });

    await first.return?.();
  });

  it("streams text deltas and finishes with the result text", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } },
      { type: "result", subtype: "success", is_error: false, result: "" },
    ];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    const events = await drain(adapter.run("cc-1", "hi"));

    expect(events).toEqual([
      { type: "text_chunk", text: "hel" },
      { type: "text_chunk", text: "lo" },
      { type: "done", finalText: "hello" },
    ]);
  });

  it("waits for a background subagent notification before emitting the main done event", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [
      {
        type: "assistant", parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id: "agent-tool", name: "Agent", input: { prompt: "inspect" } }] },
      },
      {
        type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "agent-tool",
        task_type: "local_agent", subagent_type: "Explore", description: "Inspect", is_backgrounded: true,
      },
      { type: "result", subtype: "success", is_error: false, result: "launched" },
      {
        type: "assistant", parent_tool_use_id: "agent-tool",
        message: { content: [{ type: "text", text: "Child finished" }] },
      },
      {
        type: "system", subtype: "task_updated", task_id: "task-1",
        patch: { status: "completed" },
      },
      {
        type: "system", subtype: "task_notification", task_id: "task-1", tool_use_id: "agent-tool",
        status: "completed", output_file: "/tmp/task", summary: "Child finished",
        usage: { total_tokens: 12, tool_uses: 2, duration_ms: 3200 },
      },
    ];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    const events = await drain(adapter.run("cc-1", "delegate"));

    expect(state.queryCalls[0].options).toMatchObject({
      includePartialMessages: true,
      forwardSubagentText: true,
      agentProgressSummaries: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      "tool_call",
      "native_subagent_update",
      "native_subagent_update",
      "native_subagent_update",
      "native_subagent_update",
      "done",
    ]);
    expect(events.at(-2)).toMatchObject({
      activity: { status: "completed", summary: "Child finished", toolUses: 2 },
    });
    expect(events.at(-1)).toEqual({ type: "done", finalText: "launched" });
  });

  it("reports a protocol error when the SDK ends with a background subagent still active", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{
      type: "system", subtype: "task_started", task_id: "task-1", tool_use_id: "agent-tool",
      task_type: "local_agent", description: "Inspect", is_backgrounded: true,
    }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    const events = await drain(adapter.run("cc-1", "delegate"));

    expect(events).toEqual([
      expect.objectContaining({ activity: expect.objectContaining({ status: "running" }) }),
      expect.objectContaining({ activity: expect.objectContaining({ status: "stopped" }) }),
      expect.objectContaining({ type: "error", code: "NATIVE_PROTOCOL_ERROR" }),
    ]);
  });

  it("sends ordered base64 image blocks with the initial user message", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
    const webp = Buffer.from("RIFF0000WEBP", "ascii");

    await drain(adapter.run("cc-1", "inspect both", [
      `data:image/png;base64,${png.toString("base64")}`,
      `data:image/webp;base64,${webp.toString("base64")}`,
    ]));

    await vi.waitFor(() => expect(state.inputMessages).toHaveLength(1));
    expect(state.inputMessages[0]).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: "inspect both" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: png.toString("base64") },
          },
          {
            type: "image",
            source: { type: "base64", media_type: "image/webp", data: webp.toString("base64") },
          },
        ],
      },
      parent_tool_use_id: null,
    });
  });

  it("rejects unsupported image data before opening an SDK query", async () => {
    state.sessions = [sdkSession("cc-1")];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await expect(drain(adapter.run("cc-1", "inspect", ["data:image/avif;base64,AAAA"])))
      .rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
    expect(state.queryCalls).toHaveLength(0);
  });

  it("injects steering input into the active streaming query with now priority", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "working" }] } },
      { type: "result", subtype: "success", is_error: false, result: "done" },
    ];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const iterator = adapter.run("cc-1", "initial")[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "text_chunk", text: "working" },
    });
    await expect(adapter.steer("cc-1", "focus on tests")).resolves.toBe(true);
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "done", finalText: "done" },
    });
    await expect(iterator.next()).resolves.toMatchObject({ done: true });

    await vi.waitFor(() => expect(state.inputMessages).toHaveLength(2));
    expect(state.inputMessages).toEqual([
      {
        type: "user",
        message: { role: "user", content: "initial" },
        parent_tool_use_id: null,
      },
      {
        type: "user",
        message: { role: "user", content: "focus on tests" },
        parent_tool_use_id: null,
        priority: "now",
      },
    ]);
    await expect(adapter.steer("cc-1", "too late")).resolves.toBe(false);
  });

  it("surfaces SDK failures as error events", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "result", subtype: "error_during_execution", is_error: true, errors: ["boom"] }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    const events = await drain(adapter.run("cc-1", "hi"));

    expect(events).toEqual([{ type: "error", message: "boom" }]);
  });

  it("rejects a session id that does not match the SDK init message", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "system", subtype: "init", session_id: "cc-other" }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    const events = await drain(adapter.run("cc-1", "hi"));

    expect(events[0]).toMatchObject({ type: "error", code: "NATIVE_PROTOCOL_ERROR" });
    expect(events[0]).toMatchObject({ message: expect.stringContaining("cc-other") });
  });

  it("uses Claude bypass permissions without installing a callback in full access mode", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];
    state.triggerPermission = true;
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await drain(adapter.run("cc-1", "run without approval", undefined, undefined, undefined, {
      permissionMode: "full-access",
    }));

    expect(state.queryCalls[0].options).toMatchObject({
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(state.queryCalls[0].options).not.toHaveProperty("canUseTool");
    expect(state.permissionResult).toBeNull();
  });

  it("keeps shell, network, and unknown Claude tools behind approval in auto mode", () => {
    const cwd = "/repo";
    expect(requiresClaudeApproval("auto-approval", classifyClaudePermission("Bash", { command: "pwd" }, cwd))).toBe(true);
    expect(requiresClaudeApproval("auto-approval", classifyClaudePermission("WebFetch", { url: "https://example.test" }, cwd))).toBe(true);
    expect(requiresClaudeApproval("auto-approval", classifyClaudePermission("UnrecognizedTool", {}, cwd))).toBe(true);
    expect(requiresClaudeApproval("auto-approval", classifyClaudePermission("Read", { file_path: "README.md" }, cwd))).toBe(false);
    expect(requiresClaudeApproval("auto-approval", classifyClaudePermission("Write", { file_path: "src/new.ts" }, cwd))).toBe(false);
  });

  it("routes an auto-approved Claude shell request through the persisted approval path", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "running" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    state.triggerPermission = true;
    state.signal = new AbortController().signal;
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const events: any[] = [];

    for await (const event of adapter.run("cc-1", "run pwd", undefined, undefined, undefined, {
      permissionMode: "auto-approval",
    })) {
      events.push(event);
      if (event.type === "ask_user") {
        await adapter.answerQuestion(event.questionId, { answer: "允许一次" });
      }
    }

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "ask_user", questionId: "claude:cc-1:req-1" }),
    ]));
    await expect(state.permissionResult).resolves.toMatchObject({ behavior: "allow" });
  });

  it("routes permission prompts through the ask-user contract and resolves allow", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "running" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    state.triggerPermission = true;
    state.signal = new AbortController().signal;
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    const events: any[] = [];
    let answered = false;
    for await (const event of adapter.run("cc-1", "run pwd", undefined, undefined, undefined, {
      permissionMode: "request-approval",
    })) {
      events.push(event);
      if (event.type === "ask_user" && !answered) {
        answered = true;
        await adapter.answerQuestion(event.questionId, { answer: "允许一次" });
      }
    }

    const question = events.find((event) => event.type === "ask_user");
    expect(question).toMatchObject({ questionId: "claude:cc-1:req-1", question: "运行命令" });
    expect(question.options.map((option: any) => option.label))
      .toEqual(["允许一次", "本会话允许", "拒绝", "取消"]);
    await expect(state.permissionResult).resolves.toMatchObject({
      behavior: "allow",
      updatedInput: { command: "pwd" },
    });
    expect(await adapter.answerQuestion("claude:cc-1:req-1", { answer: "允许一次" })).toBe(false);
  });

  it("denies and interrupts on cancel, and records session-wide permissions", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "running" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    state.triggerPermission = true;
    state.signal = new AbortController().signal;
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    for await (const event of adapter.run("cc-1", "run pwd", undefined, undefined, undefined, {
      permissionMode: "request-approval",
    })) {
      if (event.type === "ask_user") await adapter.answerQuestion(event.questionId, { answer: "取消" });
    }
    await expect(state.permissionResult).resolves.toMatchObject({ behavior: "deny", interrupt: true });

    state.triggerPermission = true;
    state.stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "running again" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    for await (const event of adapter.run("cc-1", "again", undefined, undefined, undefined, {
      permissionMode: "request-approval",
    })) {
      if (event.type === "ask_user") await adapter.answerQuestion(event.questionId, { answer: "本会话允许" });
    }
    const allowed = await state.permissionResult;
    expect(allowed.behavior).toBe("allow");
    expect(allowed.updatedPermissions).toHaveLength(1);
  });

  it("aborts an active query and stays silent when nothing is running", async () => {
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    await expect(adapter.abort("nothing")).resolves.toBeUndefined();
    expect(state.interrupted).toBe(0);

    state.sessions = [sdkSession("cc-1")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "ok" }];
    const iterator = adapter.run("cc-1", "hi")[Symbol.asyncIterator]();
    await iterator.next();
    await adapter.abort("cc-1");

    expect(state.interrupted).toBe(1);
    await iterator.return?.();
  });

  it("closes active queries and rejects pending permissions on dispose", async () => {
    state.sessions = [sdkSession("cc-1")];
    state.stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "running" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    state.triggerPermission = true;
    state.signal = new AbortController().signal;
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    for await (const event of adapter.run("cc-1", "hi", undefined, undefined, undefined, {
      permissionMode: "request-approval",
    })) {
      if (event.type === "ask_user") {
        await adapter.dispose();
        break;
      }
    }

    await expect(state.permissionResult).resolves.toMatchObject({
      behavior: "deny",
      message: "Customer Agent is shutting down",
      interrupt: true,
    });
    expect(state.closedQueries).toBeGreaterThan(0);
  });
});

async function drain(iterable: AsyncIterable<any>): Promise<any[]> {
  const events: any[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

describe("Claude model & reasoning-effort overrides", () => {
  it("forwards per-run model and effort into the SDK query options", async () => {
    state.sessions = [sdkSession("cc-model")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await drain(adapter.run("cc-model", "hello", undefined, undefined, undefined, {
      model: { id: "claude-opus-4-6" },
      reasoningEffort: "high",
    }));

    expect(state.queryCalls[0].options.model).toBe("claude-opus-4-6");
    expect(state.queryCalls[0].options.effort).toBe("high");
  });

  it("omits model and effort when the run carries none", async () => {
    state.sessions = [sdkSession("cc-model")];
    state.stream = [{ type: "result", subtype: "success", is_error: false, result: "done" }];
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });

    await drain(adapter.run("cc-model", "hello"));

    expect(state.queryCalls[0].options.model).toBeUndefined();
    expect(state.queryCalls[0].options.effort).toBeUndefined();
  });

  it("exposes the stable model aliases for the picker", async () => {
    const adapter = new ClaudeRuntimeAdapter({ sessionRoot: "/tmp/claude-projects" });
    const models = await adapter.listModels();
    expect(models.map((model) => model.id)).toEqual(["sonnet", "opus", "haiku"]);
    expect(models.find((model) => model.id === "opus")?.reasoningEfforts).toContain("max");
  });
});
