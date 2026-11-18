import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHttpGateway } from "./agent-http-gateway";

class ObservedEventSource {
  static readonly CLOSED = 2;
  static instances: ObservedEventSource[] = [];
  readonly readyState = 1;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly close = vi.fn();

  constructor(readonly url: string) {
    ObservedEventSource.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }
}

const originalEventSource = globalThis.EventSource;
const sessionId = "runtime:codex:external-successor";

afterEach(() => {
  vi.useRealTimers();
  globalThis.EventSource = originalEventSource;
  ObservedEventSource.instances = [];
});

describe("native replay turn identity", () => {
  it.each(["codex", "claude-code", "opencode", "deepseek-harness", "copilot", "qoder", "zcode", "workbuddy"])(
    "does not attach a terminal retained %s run to a newly running native session", async agentType => {
      vi.useFakeTimers();
      globalThis.EventSource = ObservedEventSource as unknown as typeof EventSource;
      const http = { get: vi.fn().mockResolvedValue({
        agentType, status: "running", occupancy: "available", snapshotRunId: "previous-run",
        snapshotRunStatus: "terminal", snapshotRevision: 251, snapshotTurnId: null,
        history: { delivery: "legacy-full" },
        messages: [{ role: "user", content: "native input", historyId: "history-message.v1.4.user" }], events: [],
      }) };
      const gateway = new AgentHttpGateway(http as never, {} as never);
      const events: unknown[] = [];
      gateway.onEvent(event => events.push(event));

      await gateway.getSession(`runtime:${agentType}:external-successor`, { limit: 50 });
      await vi.advanceTimersByTimeAsync(2_000);

      expect(ObservedEventSource.instances).toHaveLength(0);
      expect(http.get).toHaveBeenCalledOnce();
      expect(events).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("does not apply an old Copilot completion when the new VS Code turn finishes", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = ObservedEventSource as unknown as typeof EventSource;
    const native = {
      agentType: "copilot", occupancy: "available", snapshotRunId: "previous-run", snapshotRunStatus: "terminal",
      snapshotRevision: 251, snapshotTurnId: "previous-turn", history: { delivery: "legacy-full" },
      messages: [
        { role: "user", content: "new editor input", historyId: "history-message.v1.4.user" },
        { role: "assistant", content: "new editor output", historyId: "history-message.v1.5.answer",
          presentation: { nativeMessageId: "new-native-turn:part-1" } },
      ], events: [{ type: "done", finalText: "previous answer", durationMs: 359146 }],
    };
    const http = { get: vi.fn()
      .mockResolvedValueOnce({ ...native, status: "running" })
      .mockResolvedValue({ ...native, status: "idle" }) };
    const gateway = new AgentHttpGateway(http as never, {} as never);
    const events: unknown[] = [];
    gateway.onEvent(event => events.push(event));

    await gateway.getSession("runtime:copilot:editor-successor", { limit: 50 });
    await vi.advanceTimersByTimeAsync(2_000);
    await gateway.getSession("runtime:copilot:editor-successor", { limit: 50 });

    expect(ObservedEventSource.instances).toHaveLength(0);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["deepseek-harness", "copilot"])("continues an active %s broker run after its full history snapshot", async agentType => {
    vi.useFakeTimers();
    globalThis.EventSource = ObservedEventSource as unknown as typeof EventSource;
    const gateway = new AgentHttpGateway({ get: vi.fn().mockResolvedValue({
      agentType, status: "running", occupancy: "available", snapshotRunId: "current-run", snapshotRunStatus: "active",
      snapshotRevision: 5, snapshotTurnId: null, history: { delivery: "legacy-full" },
      messages: [{ role: "user", content: "current input" }], events: [],
    }) } as never, {} as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent(event => events.push(event as Record<string, unknown>));

    await gateway.getSession(`runtime:${agentType}:current-run`, { limit: 50 });
    const source = ObservedEventSource.instances[0];
    expect(source.url).toContain("afterSequence=5");
    expect(source.url).toContain("afterRunId=current-run");
    for (const event of [
      { type: "text_chunk", text: "new delta", _nativeRunId: "current-run", _nativeSequence: 6 },
      { type: "done", finalText: "current output", _nativeRunId: "current-run", _nativeSequence: 7 },
    ]) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));

    expect(events).toContainEqual(expect.objectContaining({ type: "text_chunk", text: "new delta" }));
    expect(events).toContainEqual(expect.objectContaining({ type: "done", finalText: "current output" }));
    expect(source.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replay the previous broker run into a newer external Codex turn", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = ObservedEventSource as unknown as typeof EventSource;
    const gateway = new AgentHttpGateway({ get: vi.fn().mockResolvedValue({
      status: "running", occupancy: "available", snapshotRunId: "previous-run", snapshotRevision: 251,
      snapshotTurnId: "previous-turn", history: { delivery: "core" },
      messages: [0, 1, 2].map(segmentIndex => ({
        role: "user", content: `external input ${segmentIndex}`,
        presentation: { executionTrace: { turnId: "external-turn", segmentIndex } },
      })), events: [],
    }) } as never, {} as never);
    const events: unknown[] = [];
    gateway.onEvent(event => events.push(event));

    await gateway.getSession(sessionId, { view: "core", limit: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(ObservedEventSource.instances).toHaveLength(0);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replays unhydrated events for the matching active native turn", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = ObservedEventSource as unknown as typeof EventSource;
    const gateway = new AgentHttpGateway({ get: vi.fn().mockResolvedValue({
      status: "running", occupancy: "available", snapshotRunId: "current-run", snapshotRevision: 5,
      snapshotTurnId: "current-turn", history: { delivery: "core" },
      messages: [{ role: "user", content: "current input", presentation: { executionTrace: { turnId: "current-turn" } } }],
      events: [],
    }) } as never, {} as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent(event => events.push(event as Record<string, unknown>));

    await gateway.getSession(sessionId, { view: "core", limit: 1 });
    const source = ObservedEventSource.instances[0];
    expect(source.url).toContain("afterSequence=0");
    expect(source.url).toContain("afterRunId=current-run");
    for (const event of [
      { type: "text_chunk", text: "current output", turnId: "current-turn", _nativeRunId: "current-run", _nativeSequence: 1 },
      { type: "done", finalText: "current output", _nativeRunId: "current-run", _nativeSequence: 6 },
    ]) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));

    expect(events).toContainEqual(expect.objectContaining({ type: "text_chunk", text: "current output" }));
    expect(source.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { view: "trace" as const, turnId: "older-turn" },
    { view: "core" as const, before: "history.v1.4" },
    { view: "core" as const, after: "history.v1.4" },
    { view: "core" as const, anchor: "history-anchor" },
  ])("does not attach a run stream while reading a history window %j", async query => {
    vi.useFakeTimers();
    globalThis.EventSource = ObservedEventSource as unknown as typeof EventSource;
    const gateway = new AgentHttpGateway({ get: vi.fn().mockResolvedValue({
      status: "running", snapshotRunId: "retained-run", snapshotRevision: 251,
      snapshotTurnId: "retained-turn", history: { delivery: query.view },
      messages: [], events: [],
    }) } as never, {} as never);

    await gateway.getSession(sessionId, query);

    expect(ObservedEventSource.instances).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a retained terminal run without publishing its answer on an external successor", async () => {
    vi.useFakeTimers();
    globalThis.EventSource = ObservedEventSource as unknown as typeof EventSource;
    const gateway = new AgentHttpGateway({
      post: vi.fn().mockResolvedValue({ runId: "previous-run" }),
      get: vi.fn().mockResolvedValue({
        status: "idle", snapshotRunId: "previous-run", snapshotRunStatus: "terminal", snapshotRevision: 251,
        snapshotTurnId: "previous-turn", history: { delivery: "core" },
        messages: [{ role: "user", content: "external input", presentation: { executionTrace: { turnId: "external-turn" } } }],
        events: [],
      }),
    } as never, {} as never);
    const events: Array<Record<string, unknown>> = [];
    gateway.onEvent(event => events.push(event as Record<string, unknown>));
    const run = gateway.run("previous input", sessionId);
    await vi.advanceTimersByTimeAsync(0);
    const source = ObservedEventSource.instances[0];

    await gateway.getSession(sessionId, { view: "core", limit: 1 });
    await run;

    expect(source.close).toHaveBeenCalledOnce();
    expect(events.some(event => ["text_chunk", "done", "error"].includes(String(event.type)))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
