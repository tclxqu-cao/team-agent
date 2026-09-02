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
  RuntimeHealth,
  RuntimeQuestionAnswer,
  RuntimeRunOptions,
  UnifiedSessionDetail,
  UnifiedSessionSummary,
} from "./types";
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

  health = async (): Promise<RuntimeHealth[]> => [{ agentType: "codex", available: true, label: "Codex" }];
  list = async (): Promise<UnifiedSessionSummary[]> => [summary(this.occupancy, this.status)];
  refresh = this.list;
  create = async (): Promise<UnifiedSessionSummary> => summary();
  fork = async (): Promise<UnifiedSessionSummary> => summary();
  getSessionWatchPath = async (): Promise<string | null> => null;
  steer = async (): Promise<boolean> => true;
  abort = async (): Promise<void> => { this.resolveRun?.(); };
  dispose = async (): Promise<void> => { this.resolveRun?.(); };
  get = async (): Promise<UnifiedSessionDetail> => ({
    ...summary(this.occupancy, this.status),
    messages: this.messages,
    events: [],
  });

  async *run(
    _id: string,
    _input: string,
    _images?: string[],
    _agentIds?: string[],
    _agentName?: string,
    options?: RuntimeRunOptions,
  ): AsyncIterable<AgentEvent> {
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
    yield { type: "done", finalText: "completed" };
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
