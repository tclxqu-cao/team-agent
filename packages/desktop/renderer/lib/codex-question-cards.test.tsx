import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { codexTurnsToMessages } from "../../../native-runtime/src/agent-runtime/codex-runtime-adapter";
import { codexAsyncQuestionId, codexQuestionReply } from "../../../native-runtime/src/agent-runtime/codex-questions";
import AskUserCard from "../components/AskUserCard";
import { restoreSessionHistoryPage } from "./session-history";
import { presentQuestionAnswers } from "./ask-user-answer-display";
import { hasPendingSessionQuestion } from "./sidebar-session-status";

describe("Codex Desktop questions in the mobile chat history", () => {
  it.each(["pending", "answered", "cancelled"] as const)("restores a %s card without a live event or duplicate Desktop answer", async status => {
    const questionId = codexAsyncQuestionId("desktop", "ask", 0);
    const turns = [{ id: "original", status: status === "cancelled" ? "interrupted" : "completed", items: [{
      type: "agentMessage", id: "ask", text: "选择范围？", delivery: "async", questions: [{ title: "选择范围？", options: ["推荐", "全部"] }],
    }] }];
    if (status === "answered") turns.push({ id: "reply", status: "completed", items: [{ type: "userMessage", id: "answer",
      content: [{ type: "text", text: codexQuestionReply(questionId, "选择范围？", "全部") }],
    } as never] });
    const messages = await codexTurnsToMessages(turns, { nativeSessionId: "desktop" });
    const restored = restoreSessionHistoryPage({ agentType: "codex", messages, events: [],
      history: { delivery: "core", revision: "questions", newerCursor: null, olderCursor: null, nextCursor: null, hasMore: false, pageSize: messages.length, totalItems: messages.length, kind: "latest" } });
    const visible = presentQuestionAnswers(restored, true);
    const cards = visible.filter(message => message.askUser);
    expect(cards).toHaveLength(1);
    expect(hasPendingSessionQuestion(cards)).toBe(status === "pending");
    const html = renderToStaticMarkup(createElement(AskUserCard, { ...cards[0].askUser!, onAnswer: vi.fn() }));
    expect(html).toContain(status === "pending" ? "向你提问" : status === "answered" ? "已回答" : "已中断");
    expect(html.includes("<button")).toBe(status === "pending");
    expect(html).toContain("选择范围？");
    expect(visible.some(message => message.content.includes("send_user_message_question_reply"))).toBe(false);
  });
});
