import { describe, expect, it, vi } from "vitest";
import { CodexRuntimeAdapter, codexTurnsToMessages } from "./codex-runtime-adapter.js";

const question = {
  type: "agentMessage", id: "async-question", text: "选择范围？\n- 推荐\n- 全部",
  phase: "final_answer", delivery: "async",
  questions: [{ title: "选择范围？", options: ["推荐", "全部"] }, { title: "其他要求？", options: null }],
};

async function start() {
  let notify: (event: any) => void = () => undefined;
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const thread = {
    id: "async-thread", name: "async", preview: "async", createdAt: 1, updatedAt: 1,
    status: { type: "idle" }, path: null, cwd: "/tmp", source: "vscode", turns: [],
  };
  const request = vi.fn(async (method: string, _params?: unknown): Promise<any> => {
    if (method === "thread/read" || method === "thread/resume") return { thread };
    if (method === "turn/start") { signalStarted(); return { turn: { id: "async-turn" } }; }
    return {};
  });
  const resolved = vi.fn();
  const adapter = new CodexRuntimeAdapter({
    client: {
      onNotification: (handler: typeof notify) => { notify = handler; return () => undefined; },
      onExit: () => () => undefined,
      setServerRequestHandler: () => undefined,
      request,
    } as never,
    onApprovalResolved: resolved,
  });
  const events: any[] = [];
  const finished = (async () => {
    for await (const event of adapter.run(thread.id, "start", undefined, undefined, undefined, { brokerRunId: "async-run" })) {
      events.push(event);
    }
  })();
  await started;
  await Promise.resolve();
  const emit = (method: string, params: Record<string, unknown>) => notify({
    method, params: { threadId: thread.id, turnId: "async-turn", ...params },
  });
  return { adapter, events, request, resolved, emit, finish: async () => {
    emit("turn/completed", { turn: { id: "async-turn", status: "completed", items: [question] } });
    await finished;
  } };
}

describe("Codex asynchronous questions", () => {
  it("emits every question once, suppresses final-answer deltas, and steers the current turn", async () => {
    const run = await start();
    try {
      run.emit("item/started", { item: { ...question, questions: [] } });
      run.emit("item/agentMessage/delta", { itemId: question.id, delta: question.text });
      run.emit("item/completed", { item: question });
      await vi.waitFor(() => expect(run.events.filter((event) => event.type === "ask_user")).toHaveLength(2));
      const [first, second] = run.events.filter((event) => event.type === "ask_user");
      expect(first).toMatchObject({ question: "选择范围？", options: [{ label: "推荐" }, { label: "全部" }] });
      expect(second).toMatchObject({ question: "其他要求？" });
      expect(run.events.some((event) => event.type === "text_chunk")).toBe(false);
      await expect(run.adapter.answerQuestion(first.questionId, { answer: "推荐" })).resolves.toBe(true);
      expect(run.request).toHaveBeenCalledWith("turn/steer", {
        threadId: "async-thread", expectedTurnId: "async-turn",
        input: [{ type: "text", text: "关于“选择范围？”的回答：\n推荐", text_elements: [] }],
      });
      await expect(run.adapter.answerQuestion(first.questionId, { answer: "重复" })).resolves.toBe(false);
      run.emit("item/completed", { item: question });
      await Promise.resolve();
      expect(run.events.filter((event) => event.type === "ask_user")).toHaveLength(2);
      expect(run.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    } finally { await run.finish(); }
    expect(run.resolved).toHaveBeenCalledTimes(1);
    expect(run.events.at(-1)).toMatchObject({ type: "done", finalText: "" });
  });

  it("keeps failed answers retryable and expires unanswered cards when the turn ends", async () => {
    const run = await start();
    let id = "";
    try {
      run.emit("item/completed", { item: question });
      await vi.waitFor(() => expect(run.events.filter((event) => event.type === "ask_user")).toHaveLength(2));
      id = run.events.find((event) => event.type === "ask_user").questionId;
      run.request.mockRejectedValueOnce(new Error("Temporary disconnect"));
      await expect(run.adapter.answerQuestion(id, { answer: "推荐" })).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
      await expect(run.adapter.answerQuestion(id, { answer: "推荐" })).resolves.toBe(true);
    } finally { await run.finish(); }
    await expect(run.adapter.answerQuestion(id, { answer: "too late" })).resolves.toBe(false);
  });

  it("keeps async question text as historical progress without labeling it a final answer", async () => {
    const active = await codexTurnsToMessages([{ id: "turn", status: "inProgress", items: [question] }]);
    expect(active).toEqual([]);
    const history = await codexTurnsToMessages([{ id: "turn", status: "completed", items: [question] }]);
    expect(history).toEqual([expect.objectContaining({
      content: question.text, presentation: { agentMessagePhase: "commentary" },
    })]);
  });
});
