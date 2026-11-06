import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { paginateSessionHistory } from "@agent/core";
import { decodeZCodeHistory } from "../../../native-runtime/src/agent-runtime/zcode-client";
import AskUserCard from "../components/AskUserCard";
import { restoreSessionHistoryPage } from "./session-history";
import { hasPendingSessionQuestion } from "./sidebar-session-status";

const question = "云效登录后强制要求修改密码才能进入工作台。如何处理？";
const options = [{ label: "我指定密码", description: "由用户指定" }, { label: "暂停", description: "先不继续" }];
const nativeHistory = (status: string) => [{ info: { id: "native-message", role: "assistant" }, parts: [{
  type: "tool", callID: "call-question", tool: "AskUserQuestion", state: { status, input: { questions: [{ question, options, multiSelect: false }] },
    output: `User has answered your questions: "${question}"="我指定密码". You can now continue with the user's answers in mind.` },
}] }];

describe("ZCode question cards through native history, pagination and renderer", () => {
  it("restores one answerable card for the original pending question", () => {
    const messages = decodeZCodeHistory(nativeHistory("running"), "sess-native");
    const page = paginateSessionHistory(messages, [{ type: "ask_user", questionId: "zcode-interaction:stable", question, options, multiSelect: false }], { limit: 50 }, { includePendingQuestions: true });
    const restored = restoreSessionHistoryPage({ agentType: "zcode", ...page });
    expect(restored).toHaveLength(1);
    expect(restored[0].askUser).toMatchObject({ questionId: "zcode-interaction:stable", question, options });
    expect(restored[0].toolCalls).toBeUndefined();
    expect(hasPendingSessionQuestion(restored)).toBe(true);
    const html = renderToStaticMarkup(createElement(AskUserCard, { ...restored[0].askUser!, onAnswer: vi.fn() }));
    expect(html).toContain("向你提问");
    expect(html).toContain(question);
    expect(html).toContain("我指定密码");
    expect(html).toContain("<button");
    expect(html).not.toContain("AskUserQuestion");
  });

  it.each(["completed", "error"])("keeps a %s question as one read-only card after refresh", status => {
    const messages = decodeZCodeHistory(nativeHistory(status), "sess-native");
    const page = paginateSessionHistory(messages, [], { limit: 50 }, { includePendingQuestions: true });
    const restored = restoreSessionHistoryPage({ agentType: "zcode", ...page });
    expect(restored).toHaveLength(1);
    expect(restored[0].toolCalls).toBeUndefined();
    expect(hasPendingSessionQuestion(restored)).toBe(false);
    const html = renderToStaticMarkup(createElement(AskUserCard, { ...restored[0].askUser!, onAnswer: vi.fn() }));
    expect(html).toContain(status === "completed" ? "已回答" : "已中断");
    expect(html).toContain(question);
    expect(html).toContain("我指定密码");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("AskUserQuestion");
  });
});
