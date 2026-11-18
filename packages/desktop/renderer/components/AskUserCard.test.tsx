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
    expect(html).toContain('class="ask-user-answer"');
    expect(html).toContain("打开后看到什么？");
    expect(html).toContain("白屏");
    expect(html).not.toContain("ask-user-card__header");
    expect(html).not.toContain("回答：");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("已中断");
  });
});


describe("pending question cards", () => {
  it("shows numbered choices and one send action alongside a custom answer", () => {
    const html = renderToStaticMarkup(createElement(AskUserCard, {
      questionId: "pending-question", question: "这张测试问答卡片显示正常吗？",
      options: [{ label: "显示正常", description: "" }, { label: "显示异常", description: "请说明异常" }],
      multiSelect: true, onAnswer: vi.fn(),
    }));
    expect(html).toContain("问题</span>");
    expect(html).toContain("可多选");
    expect(html).toContain('aria-hidden="true">1</span>');
    expect(html).toContain('aria-hidden="true">2</span>');
    expect(html).toContain("显示正常");
    expect(html).toContain("请说明异常");
    expect(html).toContain('aria-label="自定义回答"');
    expect(html).toContain("或自行撰写回复");
    expect(html.match(/>发送<\/button>/g)).toHaveLength(1);
    expect(html).toContain('class="ask-user-card__send" type="button" disabled=""');
  });

  it("keeps secret fields masked and hides their submitted values", () => {
    const field = { name: "apiKey", label: "API Key", type: "secret" as const, description: "填写密钥" };
    const pending = renderToStaticMarkup(createElement(AskUserCard, {
      questionId: "configuration", question: "请补全配置", fields: [field], onAnswer: vi.fn(),
    }));
    expect(pending).toContain('type="password"');
    expect(pending).toContain('autoComplete="off"');
    expect(pending).toContain("确认配置");
    expect(pending).not.toContain('aria-label="自定义回答"');
    const answered = renderToStaticMarkup(createElement(AskUserCard, {
      questionId: "configuration", question: "请补全配置", fields: [field],
      answered: true, answer: '{"apiKey":"private-key"}', onAnswer: vi.fn(),
    }));
    expect(answered).toContain("配置已提交（敏感字段已隐藏）");
    expect(answered).not.toContain("private-key");
    expect(answered).not.toContain("<input");
    expect(answered).not.toContain("<button");
  });
});
