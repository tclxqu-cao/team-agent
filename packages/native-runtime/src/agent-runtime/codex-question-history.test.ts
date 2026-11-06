import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRuntimeAdapter, codexTurnsToMessages } from "./codex-runtime-adapter.js";
import { CodexRolloutUserMessageReader } from "./codex-rollout-activity.js";
import { codexAsyncQuestionId, codexQuestionHistory, codexQuestionReply } from "./codex-questions.js";

const question = { type: "agentMessage", id: "ask", delivery: "async", phase: "final_answer", text: "Choose?", questions: [
  { title: "Choose?", options: ["A", "B"] }, { title: "Anything else?" },
] };
const user = (id: string, text: string) => ({ type: "userMessage", id, content: [{ type: "text", text }] });
const turn = (id: string, items: any[], status = "completed") => ({ id, status, items });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function fixture(
  turns = [turn("original", [user("user", "Task"), question])],
  path: string | null = null,
  summaryIncludesQuestions = false,
) {
  const thread = { id: "desktop-thread", parentThreadId: null, name: "Desktop", preview: "Desktop", createdAt: 1, updatedAt: 1,
    cwd: "/tmp", path, source: "desktop", status: { type: "idle" }, turns };
  const request = vi.fn(async (method: string, params: any): Promise<any> => {
    if (method === "thread/read" || method === "thread/resume") return { thread };
    if (method === "thread/turns/list") return { data: [...thread.turns].reverse().map(t => ({ ...t,
      items: params.itemsView === "summary" && !summaryIncludesQuestions ? t.items.filter(item => item.delivery !== "async") : t.items,
    })) };
    if (method === "turn/start" || method === "turn/steer") return { turn: { id: "answer-turn" } };
    throw new Error(`Unexpected request: ${method}`);
  });
  const adapter = new CodexRuntimeAdapter({ client: { request, onNotification: () => () => {}, onExit: () => () => {}, setServerRequestHandler: () => {} } as never });
  return { adapter, request, thread };
}

describe("Codex durable question cards", () => {
  it("restores every question in active and completed history without turning it into a final answer", async () => {
    for (const status of ["inProgress", "completed"]) {
      const messages = await codexTurnsToMessages([turn("original", [question], status)], { nativeSessionId: "desktop-thread" });
      expect(messages.map(message => message.presentation?.question)).toEqual([
        expect.objectContaining({ questionId: codexAsyncQuestionId("desktop-thread", "ask", 0), question: "Choose?", status: "pending", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }),
        expect.objectContaining({ question: "Anything else?", status: "pending", options: [] }),
      ]);
      expect(messages.every(message => message.content === message.presentation?.question?.question && !message.presentation?.agentMessagePhase)).toBe(true);
    }
  });

  it("matches desktop answers across turns by question identity, including duplicate titles", () => {
    const repeated = { ...question, id: "ask-again" };
    const history = codexQuestionHistory([
      turn("original", [question, repeated]),
      turn("reply", [user("answer", codexQuestionReply(codexAsyncQuestionId("desktop-thread", "ask", 0), "Choose?", "B"))]),
    ], "desktop-thread");
    expect(history.get("ask")?.[0].presentation?.question).toMatchObject({ status: "answered", answer: "B" });
    expect(history.get("ask")?.[1].presentation?.question?.status).toBe("pending");
    expect(history.get("ask-again")?.[0].presentation?.question?.status).toBe("pending");
    expect(codexQuestionHistory([turn("stopped", [question], "interrupted")], "desktop-thread").get("ask")?.[0].presentation?.question?.status).toBe("cancelled");
  });

  it.each([true, false])("keeps questions before same-turn answers when summary includes questions: %s", async summaryIncludesQuestions => {
    const root = await mkdtemp(join(tmpdir(), "codex-same-turn-question-")); roots.push(root);
    const path = join(root, "rollout.jsonl");
    const ask = { ...question, questions: [question.questions[0]] };
    for (const answer of [
      "关于“Choose?”的回答：\nB",
      codexQuestionReply(codexAsyncQuestionId("desktop-thread", "ask", 0), "Choose?", "B"),
    ]) {
      const items = [user("input", "Task"), ask, user("answer", answer), user("follow-up", "Next"), { ...ask, id: "ask-again" }];
      await writeFile(path, items.map(item => JSON.stringify({ type: "event_msg", payload: {
        type: "item_completed", turn_id: "original",
        item: { ...item, type: item.type === "userMessage" ? "UserMessage" : "AgentMessage" },
      } })).join("\n") + "\n");
      const { adapter, thread } = fixture([turn("original", items, "inProgress")], path, summaryIncludesQuestions);
      const detail = await adapter.getSessionPaged(thread.id, { view: "core", limit: 100 });
      expect(detail.messages.map(message => message.content)).toEqual(["Task", "Choose?", answer, "Next", "Choose?"]);
      const cards = detail.messages.flatMap(message => message.presentation?.question ?? []);
      expect(cards).toEqual([
        expect.objectContaining({ questionId: codexAsyncQuestionId(thread.id, "ask", 0), status: "answered", answer: "B" }),
        expect.objectContaining({ questionId: codexAsyncQuestionId(thread.id, "ask-again", 0), status: "pending" }),
      ]);
      const refreshed = await adapter.getSessionPaged(thread.id, { view: "core", limit: 100 });
      expect(refreshed.messages.map(message => message.historyId)).toEqual(detail.messages.map(message => message.historyId));
      expect(refreshed.history?.revision).toBe(detail.history?.revision);
      const index = await adapter.getQueryIndex(thread.id);
      expect(index?.entries.map(entry => entry.messageId)).toEqual(
        detail.messages.filter(message => message.role === "user").map(message => message.historyId),
      );
    }
  });

  it("recovers summary-omitted cards through the incremental rollout reader and keeps paging/index identities consistent", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-question-history-")); roots.push(root);
    const path = join(root, "rollout.jsonl");
    const record = (item: object, turnId = "original") => JSON.stringify({ type: "event_msg", payload: { type: "item_completed", turn_id: turnId, item } }) + "\n";
    await writeFile(path, record({ ...user("user", "Task"), type: "UserMessage" }) + record({ ...question, type: "AgentMessage" }));
    const { adapter, request, thread } = fixture([turn("original", [user("user", "Task"), question, { type: "agentMessage", id: "final", text: "Done", phase: "final_answer" }])], path);
    const core = await adapter.getSessionPaged(thread.id, { view: "core", limit: 1 });
    expect(core.messages.map(message => message.presentation?.question?.question ?? message.content)).toEqual(["Task", "Choose?", "Anything else?", "Done"]);
    expect(core.history).toMatchObject({ totalItems: 4, pageSize: 4 });
    expect(core.messages.every(message => message.historyId)).toBe(true);
    expect(request.mock.calls.some(([method, params]) => method === "thread/turns/list" && params.itemsView === "full")).toBe(false);
    const initialId = core.messages[1].presentation?.question?.questionId;
    await adapter.getQueryIndex(thread.id);
    const reply = user("answer", codexQuestionReply(initialId!, "Choose?", "B"));
    await appendFile(path, record({ ...reply, type: "UserMessage" }, "reply"));
    thread.turns.push(turn("reply", [reply, { type: "agentMessage", id: "final-reply", text: "Thanks", phase: "final_answer" }]));
    const latest = await adapter.getSessionPaged(thread.id, { view: "core", limit: 2 });
    expect(latest.messages.map(message => message.content)).toEqual([reply.content[0].text, "Thanks"]);
    const previous = await adapter.getSessionPaged(thread.id, { view: "core", limit: 2, before: latest.history?.olderCursor! });
    expect(previous.messages[1].presentation?.question).toMatchObject({ questionId: initialId, status: "answered", answer: "B" });
    const reader = new CodexRolloutUserMessageReader(17);
    expect(await reader.readAsyncMessages(path)).toHaveLength(1);
    expect(await reader.readAsyncMessages(path)).toHaveLength(1);
    await writeFile(path, "");
    expect(await reader.readAsyncMessages(path)).toEqual([]);
  });
});

describe("Codex restored question answers", () => {
  const id = codexAsyncQuestionId("desktop-thread", "ask", 0);
  it("continues a finished Desktop turn in the same thread with the native answer identity, once", async () => {
    const { adapter, request } = fixture();
    expect(await adapter.answerQuestion(id, { answer: "B" })).toBe(true);
    expect(request).toHaveBeenCalledWith("thread/resume", { threadId: "desktop-thread", excludeTurns: true });
    expect(request).toHaveBeenCalledWith("turn/start", { threadId: "desktop-thread", input: [{ type: "text", text: codexQuestionReply(id, "Choose?", "B"), text_elements: [] }] });
    expect(await adapter.answerQuestion(id, { answer: "B" })).toBe(false);
    expect(request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("steers the current external turn and preserves retryability on failure", async () => {
    const { adapter, request, thread } = fixture();
    thread.turns.push(turn("currently-running", [], "inProgress"));
    thread.status.type = "active";
    const original = request.getMockImplementation()!;
    let fail = true;
    request.mockImplementation(async (method, params) => {
      if (method === "turn/steer" && fail) { fail = false; throw new Error("Disconnected"); }
      return original(method, params);
    });
    await expect(adapter.answerQuestion(id, { answer: "B" })).rejects.toMatchObject({ code: "QUESTION_ANSWER_FAILED" });
    expect(await adapter.answerQuestion(id, { answer: "B" })).toBe(true);
    expect(request).toHaveBeenCalledWith("turn/steer", expect.objectContaining({ expectedTurnId: "currently-running" }));
    expect(request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("rechecks Desktop replies, missing questions and cancelled turns before allowing any write", async () => {
    for (const turns of [
      [turn("original", [question]), turn("reply", [user("reply", codexQuestionReply(id, "Choose?", "B"))])],
      [turn("original", [])],
      [turn("original", [question], "interrupted")],
    ]) {
      const { adapter, request } = fixture(turns);
      expect(await adapter.answerQuestion(id, { answer: "A" })).toBe(false);
      expect(request.mock.calls.map(([method]) => method)).toEqual(["thread/read"]);
    }
  });
});
