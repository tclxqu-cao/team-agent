import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentEvent } from "@agent/core";
import { AsyncEventQueue } from "./async-event-queue.js";
import type { HarnessConnection, HarnessRecord } from "./deepseek-harness-client.js";
import { HarnessInteractions } from "./deepseek-harness-interactions.js";
import { harnessQuestionId, parseHarnessQuestionId } from "./deepseek-harness-interaction-codec.js";

const dispose: Array<() => void> = [];
afterEach(() => { for (const stop of dispose.splice(0)) stop(); });
const questions = [
  { id: "stack", question: "选择方案", options: [{ label: "方案 A" }, { label: "方案 B" }], multiSelect: true },
  { id: "detail", question: "补充要求" },
];
const projection = (state = "continued") => ({ userQuestions: { active: [{ callId: "call", state, questions }], settled: [] } });
function setup() {
  const queue = new AsyncEventQueue<HarnessRecord>();
  const request = vi.fn(async (): Promise<unknown> => true);
  const client: HarnessConnection = { request, open: vi.fn(async () => ({ values: queue, close: () => queue.close() })),
    follow: vi.fn(), dispose: vi.fn() };
  const bridge = new HarnessInteractions(client);
  dispose.push(() => bridge.dispose());
  queue.push({ type: "ready", clientId: "client" });
  const emit = async (value: HarnessRecord) => { queue.push(value); await new Promise(resolve => setImmediate(resolve)); };
  const id = (itemId: string, kind: "question" | "approval" = "question", requestId = "call") => harnessQuestionId({ sessionId: "session", kind, requestId, itemId });
  return { bridge, client, request, emit, id };
}

describe("Harness human interactions", () => {
  it("decodes opaque session identities and rejects malformed or noncanonical routes", () => {
    const id = harnessQuestionId({ sessionId: "a:b:中文", kind: "question", requestId: "c:1", itemId: "x" });
    expect(parseHarnessQuestionId(id)).toMatchObject({ sessionId: "a:b:中文", requestId: "c:1" });
    expect(parseHarnessQuestionId(`${id}=`)).toBeNull();
    expect(parseHarnessQuestionId("harness:bad")).toBeNull();
    expect(parseHarnessQuestionId("native:other:question")).toBeNull();
  });

  it("forwards live questions and submits one complete native batch with selections and text", async () => {
    const { bridge, request, emit, id } = setup();
    const seen: AgentEvent[] = [];
    bridge.subscribe("session", event => seen.push(event));
    await Promise.all([bridge.start(), bridge.start()]);
    await emit({ type: "waterfall", event: "user-questions/request", eventId: "event", agentId: "session", request: { questions, wait: { callId: "call", timed: true } } });
    expect(seen.filter(event => event.type === "ask_user")).toHaveLength(2);
    await expect(bridge.answer(id("stack"), { answer: "方案 B, 方案 A", selectedIndices: [1, 0] }, async () => ({}))).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
    await expect(bridge.answer(id("detail"), { answer: "需要手机使用" }, async () => ({}))).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledWith("$events/result", { clientId: "client", eventId: "event", outcome: { kind: "result", value: { answers: [
      { id: "stack", selected: ["方案 B", "方案 A"] }, { id: "detail", selected: [], custom: "需要手机使用" },
    ] } } });
    expect(bridge.events("session", {}).filter(event => event.type === "ask_user")).toEqual([]);
  });

  it.each([[0, "allowed-once"], [1, "rejected"]])("routes approval choice %s without automatic grants", async (index, outcome) => {
    const { bridge, request, emit, id } = setup();
    await bridge.start();
    await emit({ type: "waterfall", event: "approval/request", eventId: "approval", agentId: "session", request: { toolName: "bash", reason: "需要写入外部目录" } });
    expect(bridge.events("other-session", {})).toEqual([]);
    await expect(bridge.answer(id("approval", "approval", "approval"), { answer: "", selectedIndices: [index as number] }, async () => ({}))).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith("$events/result", { clientId: "client", eventId: "approval", outcome: { kind: "result", value: outcome } });
  });

  it("withdraws questions when another client answers or the Host cancels", async () => {
    const { bridge, emit, id } = setup();
    await bridge.start();
    await emit({ type: "waterfall", event: "user-questions/request", eventId: "event", agentId: "session", request: { questions, wait: { callId: "call" } } });
    expect(bridge.events("session", {}).filter(event => event.type === "ask_user")).toHaveLength(2);
    await emit({ type: "cancel", eventId: "event" });
    expect(bridge.events("session", {}).every(event => event.type === "approval_resolved")).toBe(true);
    await expect(bridge.answer(id("stack"), { answer: "x" }, async () => ({}))).resolves.toBe(false);
  });

  it("restores continued questions after reconnect and uses the native late-reply endpoint", async () => {
    const { bridge, request, id } = setup();
    await bridge.start();
    expect(bridge.events("session", projection()).filter(event => event.type === "ask_user")).toHaveLength(2);
    await bridge.answer(id("stack"), { answer: "B", selectedIndices: [1] }, async () => projection());
    expect(bridge.events("session", projection()).filter(event => event.type === "ask_user")).toHaveLength(1);
    await bridge.answer(id("detail"), { answer: "手机" }, async () => projection());
    expect(request).toHaveBeenCalledWith("userQuestions/answer", { agentId: "session", callId: "call", answer: { answers: [
      { id: "stack", selected: ["方案 B"] }, { id: "detail", selected: [], custom: "手机" },
    ] } });
    await expect(bridge.answer(id("detail"), { answer: "手机" }, async () => projection())).resolves.toBe(false);
  });

  it("hides late replies already in the native inbox instead of submitting twice", async () => {
    const { bridge, request, id } = setup();
    const projections = { ...projection(), inbox: { "next-turn": [{ source: { kind: "user-question-reply", callId: "call" } }] } };
    await expect(bridge.answer(id("stack"), { answer: "B", selectedIndices: [1] }, async () => projections)).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it("retains earlier batch answers after a submission failure and allows retry", async () => {
    const { bridge, request, id } = setup();
    await bridge.answer(id("stack"), { answer: "B", selectedIndices: [1] }, async () => projection());
    request.mockRejectedValueOnce(new Error("connection failed"));
    await expect(bridge.answer(id("detail"), { answer: "手机" }, async () => projection())).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    await expect(bridge.answer(id("detail"), { answer: "手机" }, async () => projection())).resolves.toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("validates the requested item and indices before native writes", async () => {
    const { bridge, request, id } = setup();
    await expect(bridge.answer(id("missing"), { answer: "x" }, async () => projection())).resolves.toBe(false);
    await expect(bridge.answer(id("stack"), { answer: "x", selectedIndices: [10] }, async () => projection())).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    expect(request).not.toHaveBeenCalled();
  });
});
