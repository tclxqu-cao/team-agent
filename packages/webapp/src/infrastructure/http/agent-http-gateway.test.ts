import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHttpGateway } from "./agent-http-gateway";

class FailedEventSource {
  static readonly CLOSED = 2;
  readonly readyState = FailedEventSource.CLOSED;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => this.onerror?.(new Event("error")));
  }

  close(): void {}
}

class ObservableEventSource {
  static instances: ObservableEventSource[] = [];
  readonly readyState = 1;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly close = vi.fn();

  constructor(readonly url: string) {
    ObservableEventSource.instances.push(this);
  }
}

describe("AgentHttpGateway", () => {
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    globalThis.EventSource = originalEventSource;
    ObservableEventSource.instances = [];
  });

  it("frames streamed Codex commentary and flushes it before the next tool event", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const sessionId = "runtime:codex:c291cmNl";
    const http = {
      get: vi.fn().mockResolvedValue({
        agentType: "codex",
        status: "running",
        snapshotRevision: 0,
        snapshotRunId: "run-current",
        messages: [],
        events: [],
        history: { delivery: "core", revision: "rev-1" },
      }),
    };
    const gateway = new AgentHttpGateway(http as never, {} as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent((event) => events.push(event as Record<string, unknown>));

    await gateway.getSession(sessionId, { view: "core", limit: 1 });
    const source = ObservableEventSource.instances[0];
    for (const [sequence, text] of [[1, "查"], [2, "询"], [3, "文件"]] as const) {
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
        type: "text_chunk",
        text,
        messagePhase: "commentary",
        turnId: "turn-1",
        itemId: "message-1",
        _nativeRunId: "run-current",
        _nativeSequence: sequence,
      }) }));
    }

    expect(events.filter((event) => event.type === "text_chunk")).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(events.filter((event) => event.type === "text_chunk")).toEqual([expect.objectContaining({
      text: "查询文件",
      _nativeSequence: 3,
    })]);

    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "text_chunk",
      text: "准备写入",
      messagePhase: "commentary",
      turnId: "turn-1",
      itemId: "message-2",
      _nativeRunId: "run-current",
      _nativeSequence: 4,
    }) }));
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "tool_call",
      toolCall: { id: "call-1", name: "write_file", arguments: { file_path: "a.ts" } },
      turnId: "turn-1",
      _nativeRunId: "run-current",
      _nativeSequence: 5,
    }) }));

    expect(events.slice(-2).map((event) => [event.type, event.text])).toEqual([
      ["text_chunk", "准备写入"],
      ["tool_call", undefined],
    ]);
  });

  it("settles the run and dispatches an error when the event stream cannot open", async () => {
    globalThis.EventSource = FailedEventSource as unknown as typeof EventSource;
    const http = { post: vi.fn() };
    const settings = { getModelOverride: vi.fn(() => null) };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));

    await expect(gateway.run("hello", "session-1")).resolves.toEqual([]);

    expect(http.post).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "error",
      message: "事件流连接失败",
      _sid: "session-1",
    });
  });

  it("admits a native run before opening SSE and does not wait for onopen", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    let resolvePost!: (value: { runId: string; snapshotRevision: number }) => void;
    const http = {
      post: vi.fn(() => new Promise<{ runId: string; snapshotRevision: number }>((resolve) => {
        resolvePost = resolve;
      })),
    };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent((event) => events.push(event as Record<string, unknown>));

    const run = gateway.run("hello", "runtime:codex:c291cmNl");
    expect(http.post).toHaveBeenCalledOnce();
    expect(ObservableEventSource.instances).toHaveLength(0);

    resolvePost({ runId: "run-new", snapshotRevision: 3 });
    await vi.waitFor(() => expect(ObservableEventSource.instances).toHaveLength(1));
    const source = ObservableEventSource.instances[0];
    expect(source.url).toBe(
      "/api/agent/stream?sessionId=runtime%3Acodex%3Ac291cmNl&afterSequence=0&afterRunId=run-new",
    );

    for (let sequence = 1; sequence <= 3; sequence += 1) {
      source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
        type: "runtime_progress",
        progressId: `progress-${sequence}`,
        _nativeRunId: "run-new",
        _nativeSequence: sequence,
      }) }));
    }
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "done",
      finalText: "done",
      _nativeRunId: "run-new",
      _nativeSequence: 4,
    }) }));
    await run;

    expect(events.filter((event) => event.type === "runtime_progress")).toHaveLength(3);
    expect(events.find((event) => event.type === "run_admitted")).toEqual({
      type: "run_admitted",
      _nativeRunId: "run-new",
      _sid: "runtime:codex:c291cmNl",
    });
  });

  it("keeps an existing native stream open when a refreshed page retries its running session", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const occupied = Object.assign(new Error("Session is already running"), {
      status: 409,
      code: "SESSION_ALREADY_RUNNING",
    });
    const http = {
      get: vi.fn().mockResolvedValue({
        status: "running",
        snapshotRevision: 4,
        snapshotRunId: "native-run-existing",
        messages: [],
        events: [],
      }),
      post: vi.fn().mockRejectedValue(occupied),
    };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));

    await gateway.getSession("runtime:codex:c291cmNl");
    const source = ObservableEventSource.instances[0];
    source.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    await gateway.run("retry after refresh", "runtime:codex:c291cmNl");

    expect(http.post).toHaveBeenCalledOnce();
    expect(source.close).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "SESSION_ALREADY_RUNNING",
      _preserveActiveRun: true,
      _sid: "runtime:codex:c291cmNl",
    }));
  });

  it("resumes an active customer-agent stream from the session refresh cursor", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const http = {
      get: vi.fn().mockResolvedValue({
        status: "active",
        activeRun: { runId: "ca-run-1", eventId: 7, running: true },
        messages: [
          { role: "user", content: "inspect" },
          { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: {} }] },
        ],
        events: [],
      }),
    };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    const session = await gateway.getSession("ca-session-1");

    expect(session).toMatchObject({ status: "active" });
    expect(ObservableEventSource.instances).toHaveLength(1);
    expect(ObservableEventSource.instances[0].url).toBe(
      "/api/agent/stream?sessionId=ca-session-1&afterEventId=7",
    );
  });

  it("replays progressive native events from zero and reconnects after the greatest dispatched sequence", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const sessionId = "runtime:codex:c291cmNl";
    const http = {
      get: vi.fn().mockResolvedValue({
        agentType: "codex",
        status: "running",
        snapshotRevision: 7,
        snapshotRunId: "run-current",
        messages: [],
        events: [],
        history: { delivery: "core", revision: "rev-1" },
      }),
      post: vi.fn().mockResolvedValue({}),
    };
    const gateway = new AgentHttpGateway(http as never, {} as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent((event) => events.push(event as Record<string, unknown>));

    await gateway.getSession(sessionId, { view: "core", limit: 50 });
    const first = ObservableEventSource.instances[0];
    expect(first.url).toBe(
      "/api/agent/stream?sessionId=runtime%3Acodex%3Ac291cmNl&afterSequence=0&afterRunId=run-current",
    );

    const progress = {
      type: "runtime_progress",
      progressId: "progress-7",
      phase: "thinking",
      label: "working",
      _nativeRunId: "run-current",
      _nativeSequence: 7,
    };
    first.onmessage?.(new MessageEvent("message", { data: JSON.stringify(progress) }));
    first.onmessage?.(new MessageEvent("message", { data: JSON.stringify(progress) }));
    expect(events.filter((event) => event.progressId === "progress-7")).toHaveLength(1);

    await gateway.abort(sessionId);
    await gateway.getSession(sessionId, { view: "core", limit: 50 });
    const second = ObservableEventSource.instances[1];
    expect(second.url).toBe(
      "/api/agent/stream?sessionId=runtime%3Acodex%3Ac291cmNl&afterSequence=7&afterRunId=run-current",
    );

    second.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      ...progress,
      progressId: "new-run-progress",
      _nativeRunId: "run-next",
      _nativeSequence: 1,
    }) }));
    expect(events.filter((event) => event.progressId === "new-run-progress")).toHaveLength(1);
  });

  it("does not carry an ambiguous legacy cursor into a known progressive run", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const sessionId = "runtime:codex:c291cmNl";
    const progressive = {
      agentType: "codex",
      status: "running",
      snapshotRevision: 9,
      snapshotRunId: "run-current",
      messages: [],
      events: [],
      history: { delivery: "core", revision: "rev-current" },
    };
    const http = {
      get: vi.fn()
        .mockResolvedValueOnce({
          agentType: "codex",
          status: "running",
          snapshotRevision: 7,
          messages: [],
          events: [],
          history: { delivery: "legacy-full" },
        })
        .mockResolvedValue(progressive),
      post: vi.fn().mockResolvedValue({}),
    };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await gateway.getSession(sessionId);
    expect(ObservableEventSource.instances[0].url).toBe(
      "/api/agent/stream?sessionId=runtime%3Acodex%3Ac291cmNl&afterSequence=7",
    );

    await gateway.abort(sessionId);
    await gateway.getSession(sessionId, { view: "core", limit: 50 });
    const currentRun = ObservableEventSource.instances[1];
    expect(currentRun.url).toBe(
      "/api/agent/stream?sessionId=runtime%3Acodex%3Ac291cmNl&afterSequence=0&afterRunId=run-current",
    );

    currentRun.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "runtime_progress",
      progressId: "current-progress",
      _nativeRunId: "run-current",
      _nativeSequence: 1,
    }) }));
    await gateway.abort(sessionId);
    await gateway.getSession(sessionId, { view: "core", limit: 50 });
    expect(ObservableEventSource.instances[2].url).toBe(
      "/api/agent/stream?sessionId=runtime%3Acodex%3Ac291cmNl&afterSequence=1&afterRunId=run-current",
    );
  });

  it("drops a repeated native chunk before it can corrupt the streaming think filter", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const sessionId = "runtime:codex:c291cmNl";
    const http = {
      get: vi.fn().mockResolvedValue({
        agentType: "codex",
        status: "running",
        snapshotRevision: 2,
        snapshotRunId: "run-current",
        messages: [],
        events: [],
        history: { delivery: "core", revision: "rev-1" },
      }),
    };
    const gateway = new AgentHttpGateway(http as never, {} as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent((event) => events.push(event as Record<string, unknown>));

    await gateway.getSession(sessionId, { view: "core", limit: 50 });
    const source = ObservableEventSource.instances[0];
    const partial = {
      type: "text_chunk",
      text: "<thi",
      _nativeRunId: "run-current",
      _nativeSequence: 1,
    };
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(partial) }));
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(partial) }));
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "text_chunk",
      text: "nk>hidden</think>visible",
      _nativeRunId: "run-current",
      _nativeSequence: 2,
    }) }));

    expect(events.filter((event) => event.type === "text_chunk")).toEqual([expect.objectContaining({
      text: "visible",
      _nativeSequence: 2,
    })]);
  });

  it("continues an admitted native run when Safari loses the POST response", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const http = {
      get: vi.fn()
        .mockResolvedValueOnce({
          status: "idle",
          snapshotRevision: 6,
          snapshotRunId: "run-before",
          messages: [],
          events: [],
        })
        .mockResolvedValueOnce({
          status: "running",
          snapshotRevision: 1,
          snapshotRunId: "run-after",
        }),
      post: vi.fn().mockRejectedValue(new TypeError("Load failed")),
    };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent((event) => events.push(event as Record<string, unknown>));

    await gateway.getSession("runtime:codex:c291cmNl");
    const run = gateway.run("inspect image", "runtime:codex:c291cmNl", undefined, undefined, [
      "data:image/png;base64,AAAA",
    ]);
    await vi.waitFor(() => expect(http.get).toHaveBeenCalledTimes(2));
    const source = ObservableEventSource.instances[0];

    expect(http.post).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "run_admitted",
      _nativeRunId: "run-after",
      _sid: "runtime:codex:c291cmNl",
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
    expect(source.close).not.toHaveBeenCalled();
    expect(source.url).toBe(
      "/api/agent/stream?sessionId=runtime%3Acodex%3Ac291cmNl&afterSequence=0&afterRunId=run-after",
    );

    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "text_chunk",
      text: "still replayed",
      messagePhase: "commentary",
      _nativeRunId: "run-after",
      _nativeSequence: 1,
    }) }));
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "done",
      finalText: "done",
      _nativeRunId: "run-after",
      _nativeSequence: 2,
    }) }));
    await run;

    expect(source.close).toHaveBeenCalledOnce();
    expect(events).toContainEqual(expect.objectContaining({
      type: "text_chunk",
      text: "still replayed",
      _nativeRunId: "run-after",
      _nativeSequence: 1,
    }));
  });

  it("uses an observed native SSE event to recover without another HTTP connection", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    let rejectPost!: (error: Error) => void;
    const http = {
      get: vi.fn().mockResolvedValue({
        status: "running",
        snapshotRevision: 4,
        snapshotRunId: "run-before",
        messages: [],
        events: [],
      }),
      post: vi.fn(() => new Promise((_resolve, reject) => { rejectPost = reject; })),
    };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent((event) => events.push(event as Record<string, unknown>));

    await gateway.getSession("runtime:codex:c291cmNl");
    const source = ObservableEventSource.instances[0];
    source.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const run = gateway.run("inspect image", "runtime:codex:c291cmNl");
    await vi.waitFor(() => expect(http.post).toHaveBeenCalledOnce());
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "thinking",
      _nativeRunId: "run-after",
      _nativeSequence: 1,
    }) }));
    rejectPost(new TypeError("Load failed"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "run_admitted",
      _nativeRunId: "run-after",
    })));

    expect(http.get).toHaveBeenCalledOnce();
    expect(events.some((event) => event.type === "error")).toBe(false);

    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "done",
      finalText: "done",
      _nativeRunId: "run-after",
      _nativeSequence: 2,
    }) }));
    await run;
  });

  it("localizes an unconfirmed native transport failure without retrying the run", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const http = {
      get: vi.fn().mockResolvedValue({
        status: "idle",
        snapshotRevision: 5,
        snapshotRunId: "old-run",
      }),
      post: vi.fn().mockRejectedValue(new TypeError("Load failed")),
    };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));

    const run = gateway.run("inspect image", "runtime:codex:c291cmNl");
    await run;

    expect(http.post).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "error",
      message: "网络连接中断，消息未确认发送，请重试",
      _sid: "runtime:codex:c291cmNl",
    });
    expect(ObservableEventSource.instances).toHaveLength(0);
  });

  it("persists a queued native message before returning it to the renderer", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const state = {
      active: null,
      queued: [{
        id: "queue-1",
        sessionId: "runtime:codex:c291cmNl",
        objective: "follow up",
        sourceMessageId: "chat-1",
        kind: "message",
        status: "queued",
        position: 0,
        createdAt: 1,
        updatedAt: 1,
      }],
      history: [],
    };
    const http = { post: vi.fn().mockResolvedValue({ state }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    const request = gateway.enqueueSessionMessage("runtime:codex:c291cmNl", {
      sourceMessageId: "chat-1",
      content: "follow up",
      images: ["data:image/png;base64,AAAA"],
      agentIds: ["reviewer"],
      agentName: "Reviewer",
    });
    ObservableEventSource.instances[0].onopen?.();

    await expect(request).resolves.toEqual(state);
    expect(http.post).toHaveBeenCalledWith("/api/sessions/runtime%3Acodex%3Ac291cmNl/goals", {
      kind: "message",
      objective: "follow up",
      sourceMessageId: "chat-1",
      messagePayload: {
        images: ["data:image/png;base64,AAAA"],
        agentIds: ["reviewer"],
        agentName: "Reviewer",
      },
    });
  });

  it("follows the active run when admission reports a same-client conflict before a stream existed", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const conflict = Object.assign(new Error("Session is already running"), {
      status: 409,
      code: "SESSION_ALREADY_RUNNING",
    });
    const http = { post: vi.fn().mockRejectedValue(conflict) };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));

    const run = gateway.run("queue after refresh", "runtime:codex:c291cmNl");
    await run;

    const source = ObservableEventSource.instances[0];
    expect(source.close).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: "error",
      code: "SESSION_ALREADY_RUNNING",
      _preserveActiveRun: true,
    }));
  });

  it("does not turn a real external ownership conflict into a queued run", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const occupied = Object.assign(new Error("Session is owned by another client"), {
      status: 409,
      code: "SESSION_OCCUPIED",
    });
    const http = { post: vi.fn().mockRejectedValue(occupied) };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));

    const run = gateway.run("must not queue", "runtime:codex:c291cmNl");
    await run;

    expect(ObservableEventSource.instances).toHaveLength(0);
    expect(events).toContainEqual({
      type: "error",
      code: "SESSION_OCCUPIED",
      message: "Session is owned by another client",
      _sid: "runtime:codex:c291cmNl",
    });
  });

  it("forwards native subagent activity from SSE without flattening its messages", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const http = {
      post: vi.fn().mockResolvedValue({ runId: "run-1", snapshotRevision: 0 }),
    };
    const settings = {
      getModelOverride: vi.fn(() => null),
      getReasoningEffort: vi.fn(() => "off"),
      getRunLimits: vi.fn(() => ({ maxIterations: 10, maxTokens: 100_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));

    const run = gateway.run("delegate", "runtime:claude-code:c2Vzc2lvbg");
    await vi.waitFor(() => expect(ObservableEventSource.instances).toHaveLength(1));
    const source = ObservableEventSource.instances[0];
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "native_subagent_update",
      _nativeRunId: "run-1",
      _nativeSequence: 1,
      activity: {
        taskId: "task-1",
        parentToolCallId: "agent-tool",
        description: "Inspect",
        status: "running",
        messages: [{ role: "assistant", content: "Reading" }],
      },
    }) }));
    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
      type: "done",
      _nativeRunId: "run-1",
      _nativeSequence: 2,
      finalText: "done",
    }) }));
    await run;

    expect(events).toContainEqual({
      type: "native_subagent_update",
      _nativeRunId: "run-1",
      _nativeSequence: 1,
      _sid: "runtime:claude-code:c2Vzc2lvbg",
      activity: {
        taskId: "task-1",
        parentToolCallId: "agent-tool",
        description: "Inspect",
        status: "running",
        messages: [{ role: "assistant", content: "Reading" }],
      },
    });
  });

  it("uses server settings instead of sending stale browser model overrides", async () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const model = {
      provider: "openai",
      apiKey: "local-key",
      modelId: "gpt-test",
      baseUrl: "https://example.test/v1",
    };
    const http = { post: vi.fn().mockResolvedValue({}) };
    const settings = {
      getModelOverride: vi.fn(() => model),
      getReasoningEffort: vi.fn(() => "high"),
      getRunLimits: vi.fn(() => ({ maxIterations: 24, maxTokens: 256_000 })),
    };
    const gateway = new AgentHttpGateway(http as never, settings as never);

    const run = gateway.run("configured run", "session-settings");
    const source = ObservableEventSource.instances[0];
    source.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(http.post).toHaveBeenCalledWith("/api/agent/run", {
      input: "configured run",
      sessionId: "session-settings",

    });

    source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "done", finalText: "done" }) }));
    await run;
  });

  it("forks a session through the encoded native-session endpoint", async () => {
    const forkedSummary = {
      id: "runtime:codex:Zm9yaw",
      nativeSessionId: "fork",
      title: "原会话（副本）",
    };
    const http = { post: vi.fn().mockResolvedValue(forkedSummary) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await expect(gateway.forkSession("runtime:codex:c291cmNl"))
      .resolves.toEqual(forkedSummary);
    expect(http.post).toHaveBeenCalledWith(
      "/api/sessions/runtime%3Acodex%3Ac291cmNl/fork",
      {},
    );
  });

  it("builds Agent workspace and session pagination URLs", async () => {
    const http = { get: vi.fn().mockResolvedValue({ data: [], nextCursor: null, watermark: null }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await gateway.listAgentWorkspaces("codex", {
      cursor: "page/2",
      limit: 25,
      refresh: true,
      since: "water mark",
    });
    await gateway.listAgentWorkspaceSessions("claude-code", "repo one", {
      cursor: "next page",
      limit: 10,
      refresh: true,
    });

    expect(http.get).toHaveBeenNthCalledWith(
      1,
      "/api/agent-workspaces?agentType=codex&cursor=page%2F2&limit=25&refresh=1&since=water+mark",
    );
    expect(http.get).toHaveBeenNthCalledWith(
      2,
      "/api/agent-workspaces/repo%20one/sessions?agentType=claude-code&cursor=next+page&limit=10&refresh=1",
    );
  });

  it("imports an Agent workspace through the unified HTTP endpoint", async () => {
    const result = { workspace: { workspaceId: "imported:repo" }, existing: true };
    const http = { post: vi.fn().mockResolvedValue(result) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await expect(gateway.importAgentWorkspace("claude-code", "/repo/app", "App"))
      .resolves.toEqual(result);
    expect(http.post).toHaveBeenCalledWith("/api/agent-workspaces", {
      agentType: "claude-code",
      path: "/repo/app",
      name: "App",
    });
  });

  it("forwards the native workspace cwd when creating a session", async () => {
    const http = { post: vi.fn().mockResolvedValue({ id: "session" }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await gateway.createSession("New", undefined, "codex", "/repo");

    expect(http.post).toHaveBeenCalledWith("/api/sessions", {
      title: "New",
      agentType: "codex",
      cwd: "/repo",
    });
  });

  it("releases a Codex session through its dedicated endpoint", async () => {
    const http = { post: vi.fn().mockResolvedValue({ status: "released" }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await gateway.releaseCodexSession("runtime:codex:c291cmNl");

    expect(http.post).toHaveBeenCalledWith(
      "/api/sessions/runtime%3Acodex%3Ac291cmNl/release",
      {},
    );
  });

  it("steers a durable queued message through one server operation", async () => {
    const state = { active: null, queued: [], history: [] };
    const http = { post: vi.fn().mockResolvedValue({ steered: true, state }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await expect(gateway.steerSessionMessage("runtime:claude-code:c2Vzc2lvbg", "queue-1"))
      .resolves.toEqual(state);
    expect(http.post).toHaveBeenCalledWith("/api/agent/steer", {
      sessionId: "runtime:claude-code:c2Vzc2lvbg",
      messageId: "queue-1",
    });
  });

  it("requests a bounded history page with an encoded cursor", async () => {
    const detail = { messages: [], events: [], history: { hasMore: true } };
    const http = { get: vi.fn().mockResolvedValue(detail) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await expect(gateway.getSession("runtime:codex:c291cmNl", {
      before: "history.v1.50",
      limit: 50,
    })).resolves.toEqual(detail);

    expect(http.get).toHaveBeenCalledWith(
      "/api/sessions/runtime%3Acodex%3Ac291cmNl?before=history.v1.50&limit=50",
    );
  });

  it("serializes progressive history views and lazy tool-result locators", async () => {
    const body = { turnId: "turn/1", itemId: "call 1", revision: "rev:1", byteSize: 6, content: "output" };
    const http = { get: vi.fn().mockResolvedValue(body) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await gateway.getSession("runtime:codex:c291cmNl", {
      before: "history.v1.50",
      limit: 50,
      view: "trace",
      revision: "rev:1",
      turnId: "turn/1",
    });
    await expect(gateway.getSessionToolResult("runtime:codex:c291cmNl", {
      turnId: "turn/1",
      itemId: "call 1",
      revision: "rev:1",
    })).resolves.toEqual(body);

    expect(http.get).toHaveBeenNthCalledWith(
      1,
      "/api/sessions/runtime%3Acodex%3Ac291cmNl?before=history.v1.50&limit=50&view=trace&revision=rev%3A1&turnId=turn%2F1",
    );
    expect(http.get).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/runtime%3Acodex%3Ac291cmNl/tool-result?turnId=turn%2F1&itemId=call+1&revision=rev%3A1",
    );
  });

  it("requests an anchored page and its newer neighbor independently", async () => {
    const http = { get: vi.fn().mockResolvedValue({ messages: [], events: [] }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await gateway.getSession("session/one", { anchor: "history-anchor.v1.rev.2", limit: 50 });
    await gateway.getSession("session/one", { after: "history.v1.50", limit: 50 });

    expect(http.get).toHaveBeenNthCalledWith(
      1,
      "/api/sessions/session%2Fone?anchor=history-anchor.v1.rev.2&limit=50",
    );
    expect(http.get).toHaveBeenNthCalledWith(
      2,
      "/api/sessions/session%2Fone?after=history.v1.50&limit=50",
    );
  });

  it("loads the compact query index from its dedicated endpoint", async () => {
    const index = {
      sessionId: "session/one",
      revision: "rev",
      totalQueries: 1,
      entries: [{ messageId: "m1", ordinal: 1, preview: "hello", pageToken: "a1" }],
    };
    const http = { get: vi.fn().mockResolvedValue(index) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await expect(gateway.getSessionQueryIndex("session/one")).resolves.toEqual(index);
    expect(http.get).toHaveBeenCalledWith("/api/sessions/session%2Fone/query-index");
  });

  it.each(["codex", "claude-code"])(
    "does not open a broker event stream while following an external %s run",
    async (agentType) => {
      globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
      const http = {
        get: vi.fn().mockResolvedValue({
          agentType,
          status: "running",
          occupancy: "owned-externally",
          snapshotRevision: 7,
          messages: [],
          events: [],
        }),
      };
      const gateway = new AgentHttpGateway(http as never, {} as never);

      await gateway.getSession(`runtime:${agentType}:c2Vzc2lvbg`);

      expect(ObservableEventSource.instances).toHaveLength(0);
    },
  );

  it("observes native history revisions and closes the SSE subscription", () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const gateway = new AgentHttpGateway({} as never, {} as never);
    const callback = vi.fn();
    const onError = vi.fn();

    const unsubscribe = gateway.observeSession("runtime:codex:c291cmNl", callback, onError);
    const source = ObservableEventSource.instances[0];
    source.onmessage?.(new MessageEvent("message", {
      data: JSON.stringify({ type: "session_history_changed", revision: 2 }),
    }));
    source.onmessage?.(new MessageEvent("message", { data: "not-json" }));

    expect(source.url).toBe("/api/sessions/runtime%3Acodex%3Ac291cmNl/changes");
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith({ type: "session_history_changed", revision: 2 });
    expect(onError).not.toHaveBeenCalled();

    unsubscribe();
    expect(source.close).toHaveBeenCalledOnce();
  });

  it("closes a failed history observer so the renderer can fall back to polling", () => {
    globalThis.EventSource = ObservableEventSource as unknown as typeof EventSource;
    const gateway = new AgentHttpGateway({} as never, {} as never);
    const onError = vi.fn();

    gateway.observeSession("session-1", vi.fn(), onError);
    const source = ObservableEventSource.instances[0];
    source.onerror?.(new Event("error"));

    expect(source.close).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("updates the permission mode for the encoded customer-agent session", async () => {
    const updated = { id: "session/one", permissionMode: "auto-approval" };
    const http = { patch: vi.fn().mockResolvedValue(updated) };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await expect(gateway.setSessionPermissionMode("session/one", "auto-approval"))
      .resolves.toEqual(updated);
    expect(http.patch).toHaveBeenCalledWith("/api/sessions/session%2Fone", {
      permissionMode: "auto-approval",
    });
  });

  it("uses the HTTP project adapter when the shared UI runs standalone", async () => {
    const projects = [{ id: "project-1", name: "customer-agent", description: "/workspace/customer-agent" }];
    const http = {
      get: vi.fn().mockResolvedValueOnce(projects).mockResolvedValueOnce({ valid: true }),
      post: vi.fn().mockResolvedValue(projects[0]),
    };
    const gateway = new AgentHttpGateway(http as never, {} as never);

    await expect(gateway.listProjects()).resolves.toEqual(projects);
    await expect(gateway.checkProjectPath("/workspace/customer-agent")).resolves.toBe(true);
    await expect(gateway.createProject("customer-agent", "/workspace/customer-agent"))
      .resolves.toEqual(projects[0]);

    expect(http.get).toHaveBeenNthCalledWith(1, "/api/projects");
    expect(http.get).toHaveBeenNthCalledWith(
      2,
      "/api/projects/check?path=%2Fworkspace%2Fcustomer-agent",
    );
    expect(http.post).toHaveBeenCalledWith("/api/projects", {
      name: "customer-agent",
      path: "/workspace/customer-agent",
    });
  });

  it("brokers real host projects instead of returning a synthetic project", async () => {
    const project = {
      id: "project-1",
      name: "customer-agent",
      description: "/Users/caoqu/team-agent/customer-agent",
      created: "2026-09-01T00:00:00.000Z",
      updated: "2026-09-01T00:00:00.000Z",
    };
    const bridge = {
      request: vi.fn(async (method: string) => {
        if (method === "project:list") return { projects: [project] };
        if (method === "project:roots") return { roots: ["/Users/caoqu"] };
        if (method === "project:directories") return { entries: [
          { name: "team-agent", path: "/Users/caoqu/team-agent", kind: "directory", hasChildren: true },
          { name: "README.md", path: "/Users/caoqu/README.md", kind: "file", hasChildren: false },
        ] };
        if (method === "project:create") return { project };
        if (method === "project:check") return { valid: true };
        throw new Error(method);
      }),
    };
    const gateway = new AgentHttpGateway({} as never, {} as never, bridge as never);

    await expect(gateway.listProjects()).resolves.toEqual([project]);
    await expect(gateway.listProjectRoots()).resolves.toEqual(["/Users/caoqu"]);
    await expect(gateway.listProjectDirectories("/Users/caoqu")).resolves.toEqual([
      { name: "team-agent", path: "/Users/caoqu/team-agent", kind: "directory", hasChildren: true },
      { name: "README.md", path: "/Users/caoqu/README.md", kind: "file", hasChildren: false },
    ]);
    await expect(gateway.createProject("customer-agent", project.description)).resolves.toEqual(project);
    await expect(gateway.checkProjectPath(project.description)).resolves.toBe(true);
    expect(bridge.request).toHaveBeenCalledWith("project:create", {
      name: "customer-agent",
      path: project.description,
    });
  });
});
