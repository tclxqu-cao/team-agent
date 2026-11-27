import { describe, expect, it } from "vitest";
import { decodeZCodeHistory } from "./zcode-client.js";
import { zcodeInteractionId, zcodeQuestionHistory } from "./zcode-questions.js";

const question = {
  header: "强制改密", question: "云效登录后强制要求修改密码才能进入工作台。如何处理？", multiSelect: false,
  options: [{ label: "我指定密码", description: "由用户指定" }, { label: "暂停", description: "先不继续" }],
};
const part = (status: string, output?: string) => ({ type: "tool", callID: "call-question", tool: "AskUserQuestion",
  state: { status, input: { questions: [question] }, ...(output ? { output } : {}) } });

describe("ZCode question identities", () => {
  it("reuses request IDs and scopes them to method and session", () => {
    const params = { sessionId: "sess-one", requestId: "perm-one", toolCallId: "call-one" };
    const id = zcodeInteractionId("interaction/requestUserInput", params);
    expect(zcodeInteractionId("interaction/requestUserInput", { ...params })).toBe(id);
    expect(zcodeInteractionId("interaction/requestPermission", params)).not.toBe(id);
    expect(zcodeInteractionId("interaction/requestUserInput", { ...params, sessionId: "sess-two" })).not.toBe(id);
    expect(zcodeInteractionId("interaction/requestUserInput", { ...params, requestId: "perm-two" })).not.toBe(id);
  });

  it("uses tool identity only when the request ID is absent", () => {
    const params = { sessionId: "sess-one", toolCallId: "call-one" };
    expect(zcodeInteractionId("input", params)).toBe(zcodeInteractionId("input", params));
    expect(zcodeInteractionId("input", { sessionId: "sess-one" })).not.toBe(zcodeInteractionId("input", { sessionId: "sess-one" }));
  });
});

describe("ZCode question history", () => {
  it("turns the original completed question output into one stable read-only card", () => {
    const output = `User has answered your questions: "${question.question}"="帮我改，我自己指定密码". You can now continue with the user's answers in mind.`;
    const history = [{ info: { id: "message-one", role: "assistant" }, parts: [part("completed", output)] }];
    const messages = decodeZCodeHistory(history, "sess-one");
    expect(messages).toHaveLength(1);
    expect(messages[0].presentation?.question).toMatchObject({ question: question.question, options: question.options, multiSelect: false, status: "answered", answer: "帮我改，我自己指定密码" });
    expect(messages[0].toolCalls).toBeUndefined();
    expect(decodeZCodeHistory(history, "sess-one")).toEqual(messages);
    expect(decodeZCodeHistory(history, "sess-two")[0].historyId).not.toBe(messages[0].historyId);
  });

  it("keeps cancelled questions and options without an answerable tool", () => {
    const messages = decodeZCodeHistory([{ info: { id: "message-one", role: "assistant" }, parts: [part("error")] }], "sess-one");
    expect(messages).toHaveLength(1);
    expect(messages[0].presentation?.question).toMatchObject({ question: question.question, options: question.options, status: "cancelled" });
    expect(messages[0].presentation?.question?.answer).toBeUndefined();
    expect(messages[0].toolCalls).toBeUndefined();
  });

  it("leaves pending questions to the live callback while preserving surrounding text and other tools", () => {
    const messages = decodeZCodeHistory([{ info: { id: "message-one", role: "assistant" }, parts: [
      { type: "text", text: "需要先确认。" }, part("running"),
      { type: "tool", callID: "call-read", tool: "Read", state: { status: "completed", input: {}, output: "file" } },
    ] }]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ content: "需要先确认。", toolCalls: [{ id: "call-read", name: "Read" }] });
    expect(messages[1]).toMatchObject({ role: "tool", content: "file" });
    expect(zcodeQuestionHistory(part("running"), "sess", "message")).toEqual([]);
  });

  it("preserves multi-select and structured answers without including adjacent answers", () => {
    const next = { ...question, question: "下一题？", multiSelect: true };
    const tool = part("completed", `User has answered your questions: "${question.question}"="我指定密码", "${next.question}"="A, B". You can now continue with the user's answers in mind.`);
    tool.state.input.questions.push(next);
    const messages = zcodeQuestionHistory(tool, "sess", "message")!;
    expect(messages.map(message => message.presentation?.question?.answer)).toEqual(["我指定密码", "A, B"]);
    expect(messages[1].presentation?.question?.multiSelect).toBe(true);
    expect(messages[1].historyId).not.toBe(messages[0].historyId);
    expect(zcodeQuestionHistory({ ...tool, state: { ...tool.state, input: { ...tool.state.input, answers: { [question.question]: "结构化回答" } } } }, "sess", "message")![0].presentation?.question?.answer).toBe("结构化回答");
  });

  it("keeps malformed question tools visible for diagnosis instead of discarding their input", () => {
    expect(zcodeQuestionHistory({ ...part("completed"), state: { status: "completed", input: { questions: [{}] } } }, "sess", "message")).toBeNull();
    expect(zcodeQuestionHistory({ ...part("completed"), tool: "Read" }, "sess", "message")).toBeNull();
  });
});
