import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../stores/agentStore";
import { hideAnsweredQuestionEchoes, presentQuestionAnswers } from "./ask-user-answer-display";
import { mergeProgressiveSessionHistoryPage, restoreSessionHistoryPage } from "./session-history";

const question = "Mac mini 是什么配置？";
const answer = "100.109.198.10 就这个，你自己看下";
const echoedContent = `关于“${question}”的回答：\n${answer}`;

function card(id = "native:run:async:item:0", submitted = true): ChatMessage {
  return {
    id, role: "assistant", content: "", timestamp: 1,
    askUser: { questionId: id, question, answered: submitted, answer: submitted ? answer : undefined },
  };
}

function user(content: string, id = "echo"): ChatMessage {
  return { id, role: "user", content, timestamp: 2 };
}

function desktopReply(entries = [{ itemId: "item", index: 0, question, answer }]): string {
  return `<send_user_message_question_reply>\n${JSON.stringify(entries.map((entry) => ({
    questionItemId: JSON.stringify(["request_user_input_async", entry.itemId, entry.index]),
    question: entry.question, answer: entry.answer,
  })))}\n</send_user_message_question_reply>`;
}

describe("hideAnsweredQuestionEchoes", () => {
  it("shows the submitted answer only in its card without changing stored history", () => {
    const messages = [user("开始", "start"), card(), user(echoedContent), user("继续", "follow-up")];
    expect(hideAnsweredQuestionEchoes(messages).map((message) => message.id))
      .toEqual(["start", "native:run:async:item:0", "follow-up"]);
    expect(messages).toHaveLength(4);
    expect(messages[2].content).toBe(echoedContent);
  });

  it("keeps plain replies, unrelated wrappers, unsent cards and echoes without a card", () => {
    const plain = user(answer);
    const differentQuestion = user(`关于“其他配置？”的回答：\n${answer}`);
    const differentAnswer = user(`关于“${question}”的回答：\n其他答案`);
    for (const messages of [
      [card(), plain, differentQuestion, differentAnswer],
      [card(undefined, false), user(echoedContent)],
      [user(echoedContent)],
      [card("customer-question"), user(echoedContent)],
      [user(echoedContent), card()],
    ]) expect(hideAnsweredQuestionEchoes(messages)).toEqual(messages);
  });

  it("matches each answered card to at most one echo and keeps replies with attachments", () => {
    const imageReply = { ...user(echoedContent, "image"), images: ["data:image/png;base64,test"] };
    const attachmentReply = {
      ...user(echoedContent, "attachment"),
      presentation: { attachments: [{ type: "image" as const, name: "photo.png", omitted: true }] },
    };
    const messages = [card(), imageReply, attachmentReply, user(echoedContent, "echo-1"), user(echoedContent, "echo-2")];
    expect(hideAnsweredQuestionEchoes(messages).map((message) => message.id))
      .toEqual(["native:run:async:item:0", "image", "attachment", "echo-2"]);
  });

  it("shows repeated questions and their answers once each", () => {
    const messages = [card(), user(echoedContent, "echo-1"), card("native:run:async:item:1"), user(echoedContent, "echo-2")];
    expect(hideAnsweredQuestionEchoes(messages)).toEqual([messages[0], messages[2]]);
  });

  it("keeps a single answer during core refresh, trace refresh and full reload", () => {
    const initial = [user("开始", "start"), card()];
    const detail = {
      messages: [
        { role: "user", content: "开始", presentation: { executionTrace: { turnId: "turn" } } },
        { role: "user", content: echoedContent, presentation: { executionTrace: { turnId: "turn", segmentIndex: 1 } } },
      ],
      events: [{ type: "approval_resolved", questionId: initial[1].askUser!.questionId }],
      history: { delivery: "core" as const, revision: "rev" },
    };
    const restored = restoreSessionHistoryPage(detail);
    const core = mergeProgressiveSessionHistoryPage(initial, restored, "core", detail.history);
    const coreVisible = presentQuestionAnswers(core, true);
    expect(coreVisible.filter((message) => message.askUser?.answer === answer)).toHaveLength(1);
    expect(coreVisible.some((message) => message.executionTrace?.segmentIndex === 1)).toBe(true);
    const trace = mergeProgressiveSessionHistoryPage(core, restored, "trace", detail.history);
    for (const messages of [trace, restored]) {
      expect(presentQuestionAnswers(messages, true)
        .filter((message) => message.askUser?.answered && message.askUser.answer === answer))
        .toHaveLength(1);
    }
  });
});

describe("presentQuestionAnswers", () => {
  it("closes a phone card from a desktop answer while hiding the protocol echo", () => {
    const pending = card(undefined, false);
    const reply = user(desktopReply());
    const visible = presentQuestionAnswers([pending, reply], true);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      id: pending.id, askUser: { questionId: pending.askUser!.questionId, answered: true, answer },
    });
    expect(pending.askUser?.answered).toBe(false);
    expect(reply.askUser).toBeUndefined();
  });

  it("matches native identity even when restored event cards follow the answer", () => {
    const wrongItem = card("native:run:async:other-item:0", false);
    const wrongIndex = card("native:run:async:item:1", false);
    const matching = card(undefined, false);
    const visible = presentQuestionAnswers([user(desktopReply()), wrongItem, wrongIndex, matching], true);
    expect(visible).toHaveLength(3);
    expect(visible[0]).toBe(wrongItem);
    expect(visible[1]).toBe(wrongIndex);
    expect(visible[2].askUser).toMatchObject({ answered: true, answer });
  });

  it("restores all desktop answers after a full reload and keeps their history text", () => {
    const reply = user(desktopReply([
      { itemId: "item", index: 0, question, answer },
      { itemId: "item", index: 1, question: "并发数？", answer: "3" },
    ]), "native-reply");
    const restored = restoreSessionHistoryPage({ messages: [reply], history: { delivery: "core", revision: "rev" } });
    const visible = presentQuestionAnswers(restored, true);
    expect(visible.map((message) => message.askUser)).toMatchObject([
      { question, answer, answered: true }, { question: "并发数？", answer: "3", answered: true },
    ]);
    expect(new Set(visible.map((message) => message.id)).size).toBe(2);
    expect(visible.every((message) => message.content === reply.content)).toBe(true);
  });

  it("updates a resolved placeholder with the real answer and retains unmatched batch replies", () => {
    const resolved = { ...card(), askUser: { ...card().askUser!, answer: "已处理" } };
    const reply = user(desktopReply([
      { itemId: "item", index: 0, question, answer },
      { itemId: "item", index: 1, question: "其他要求？", answer: "没有" },
    ]));
    const visible = presentQuestionAnswers([resolved, reply], true);
    expect(visible).toHaveLength(2);
    expect(visible[0].askUser?.answer).toBe(answer);
    expect(visible[1].askUser).toMatchObject({ question: "其他要求？", answer: "没有", answered: true });
  });

  it("reconciles legacy external answers with only the nearest pending occurrence", () => {
    const first = card("native:run:async:first:0", false);
    const latest = card("native:run:async:latest:0", false);
    const visible = presentQuestionAnswers([first, latest, user(echoedContent)], true);
    expect(visible).toHaveLength(2);
    expect(visible[0]).toBe(first);
    expect(visible[1].askUser).toMatchObject({ answered: true, answer });
  });

  it("does not interpret malformed, quoted, queued or attached desktop answer messages", () => {
    const text = desktopReply();
    const ordinary = [
      user(text.replace('"answer":', '"missing":')),
      user(text.replace('request_user_input_async', 'unknown-tool')),
      user(text.replace(',0]', ',-1]')),
      user(`<send_user_message_question_reply>invalid</send_user_message_question_reply>`),
      user(`引用：${text}`), user(`${text}\n继续做其他事`),
      { ...user(text), isQueued: true },
      { ...user(text), isCompactionSummary: true },
      { ...user(text), images: ["data:image/png;base64,test"] },
    ];
    expect(presentQuestionAnswers(ordinary, true)).toEqual(ordinary);
    expect(presentQuestionAnswers([user(text)], false)).toEqual([user(text)]);
  });

  it("restores an answered card after reload while retaining message and trace identity", () => {
    const reply: ChatMessage = {
      ...user(echoedContent, "history-message.v1.answer"),
      presentation: { executionTrace: { turnId: "turn", segmentIndex: 1 } },
    };
    const [restored] = presentQuestionAnswers([reply], true);
    expect(restored).toMatchObject({
      ...reply,
      askUser: { question, answer, answered: true, questionId: "answered-history:history-message.v1.answer" },
    });
    expect(reply.askUser).toBeUndefined();
  });

  it("keeps the original styled card during live updates", () => {
    const original = card();
    expect(presentQuestionAnswers([original, user(echoedContent)], true)).toEqual([original]);
  });

  it("keeps other agents, ordinary prose, incomplete envelopes and attachments as messages", () => {
    const ordinary = [
      user(answer), user(`引用：${echoedContent}`),
      user(`关于“${question}”的回答：`), user(`关于“${question}”的回答：\n  `),
      { ...user(echoedContent), images: ["data:image/png;base64,test"] },
      { ...user(echoedContent), presentation: { attachments: [{ type: "image" as const, name: "photo" }] } },
      { ...user(echoedContent), isCompactionSummary: true },
    ];
    expect(presentQuestionAnswers(ordinary, true)).toEqual(ordinary);
    expect(presentQuestionAnswers([user(echoedContent)], false)).toEqual([user(echoedContent)]);
  });

  it("preserves multiline questions and answers including quoted words", () => {
    const multilineQuestion = "选择“范围”\n和并发数？";
    const multilineAnswer = "推荐\n并发数：3";
    expect(presentQuestionAnswers([
      user(`关于“${multilineQuestion}”的回答：\n${multilineAnswer}`),
    ], true)[0].askUser).toMatchObject({
      question: multilineQuestion, answer: multilineAnswer, answered: true,
    });
  });
});
