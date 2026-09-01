import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeRuntimeAdapter,
  claudeHistoryToMessages,
  claudeSdkMessageToEvents,
} from "./claude-runtime-adapter.js";

const state = vi.hoisted(() => ({
  sessions: [] as any[],
  messages: [] as any[],
  stream: [] as any[],
  queryCalls: [] as any[],
  closedQueries: 0,
  interrupted: 0,
  openFiles: [] as string[],
  agentRecords: [] as any[],
  versionStdout: "claude 2.1.250",
  versionFails: false,
  triggerPermission: false,
  permissionResult: null as any,
  signal: undefined as AbortSignal | undefined,
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (options: any) => {
    state.queryCalls.push(options);
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
  state.closedQueries = 0;
  state.interrupted = 0;
  state.openFiles = [];
  state.agentRecords = [];
  state.versionStdout = "claude 2.1.250";
  state.versionFails = false;
  state.triggerPermission = false;
  state.permissionResult = null;
  state.signal = undefined;
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
});

describe("ClaudeRuntimeAdapter", () => {
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
      code: "SESSION_OCCUPIED",
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
    for await (const event of adapter.run("cc-1", "run pwd")) {
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

    for await (const event of adapter.run("cc-1", "run pwd")) {
      if (event.type === "ask_user") await adapter.answerQuestion(event.questionId, { answer: "取消" });
    }
    await expect(state.permissionResult).resolves.toMatchObject({ behavior: "deny", interrupt: true });

    state.triggerPermission = true;
    state.stream = [
      { type: "assistant", message: { content: [{ type: "text", text: "running again" }] } },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ];
    for await (const event of adapter.run("cc-1", "again")) {
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

    for await (const event of adapter.run("cc-1", "hi")) {
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
