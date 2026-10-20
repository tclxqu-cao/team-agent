import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import AskUserCard from "./AskUserCard";

describe("settled question cards", () => {
  it("shows interrupted questions and their options without answer controls", () => {
    const html = renderToStaticMarkup(createElement(AskUserCard, {
      questionId: "history-question", question: "打开后看到什么？", cancelled: true,
      options: [{ label: "白屏", description: "" }, { label: "静态画面", description: "" }], onAnswer: vi.fn(),
    }));
    expect(html).toContain("已中断");
    expect(html).toContain("打开后看到什么？");
    expect(html).toContain("白屏");
    expect(html).toContain("静态画面");
    expect(html).toContain("请让助手重新提问");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("已回答");
  });

  it("keeps a completed question and answer read-only", () => {
    const html = renderToStaticMarkup(createElement(AskUserCard, {
      questionId: "history-question", question: "打开后看到什么？", answered: true, answer: "白屏", onAnswer: vi.fn(),
    }));
    expect(html).toContain("已回答");
    expect(html).toContain("白屏");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("已中断");
  });
});
