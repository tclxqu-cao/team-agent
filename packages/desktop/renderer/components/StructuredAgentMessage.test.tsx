import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import StructuredAgentMessage from "./StructuredAgentMessage";

const baseProps = {
  complete: true,
  renderText: (text: string) => createElement("span", { "data-renderer": "markdown" }, text),
  suggestionsEnabled: true,
  onSuggestionSend: () => undefined,
};

describe("StructuredAgentMessage", () => {
  it("renders an Agent envelope with readable labels and disclosures", () => {
    const html = renderToStaticMarkup(createElement(StructuredAgentMessage, {
      ...baseProps,
      text: JSON.stringify({
        schemaVersion: 1,
        skill: "portfolio-chat",
        title: "关于工作经历",
        summary: "仅展示公开信息",
        blocks: [{ type: "text", text: "暂无可公开履历" }],
        suggestions: ["/whoami", "/project agentroam"],
        sources: ["public/profile.md"],
        generatedAt: "2026-09-24T14:44:48+08:00",
      }),
    }));

    expect(html).toContain('data-kind="envelope"');
    expect(html).toContain("关于工作经历");
    expect(html).toContain("仅展示公开信息");
    expect(html).toContain('data-renderer="markdown"');
    expect(html).toContain("暂无可公开履历");
    expect(html).toContain("关于我");
    expect(html).toContain("查看项目：agentroam");
    expect(html).toContain("发送 /whoami");
    expect(html).toContain("参考来源 1");
    expect(html).toContain("消息信息");
    expect(html).toContain("查看原始 JSON");
    expect(html).toContain("复制原始 JSON");
  });

  it("disables suggestion actions when chat cannot send", () => {
    const html = renderToStaticMarkup(createElement(StructuredAgentMessage, {
      ...baseProps,
      suggestionsEnabled: false,
      text: JSON.stringify({
        schemaVersion: 1,
        title: "Actions",
        blocks: [{ type: "text", text: "Choose" }],
        suggestions: ["/works"],
      }),
    }));
    expect(html).toContain("structured-agent-suggestion");
    expect(html).toContain("disabled");
  });

  it("renders unknown HTML blocks as escaped data", () => {
    const html = renderToStaticMarkup(createElement(StructuredAgentMessage, {
      ...baseProps,
      text: JSON.stringify({
        schemaVersion: 1,
        title: "Unsafe block",
        blocks: [{ type: "html", html: "<script>alert(1)</script>" }],
      }),
    }));
    expect(html).toContain("html 内容");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("renders generic object, array, and empty values as a tree", () => {
    const html = renderToStaticMarkup(createElement(StructuredAgentMessage, {
      ...baseProps,
      text: JSON.stringify({
        status: "ok",
        items: [1, true, null],
        empty: {},
      }),
    }));
    expect(html).toContain('data-kind="json"');
    expect(html).toContain("结构化数据");
    expect(html).toContain("status");
    expect(html).toContain("items");
    expect(html).toContain("数组 · 3 项");
    expect(html).toContain("empty");
    expect(html).toContain("对象 · 0 项");
    expect(html).toContain("空");
    expect(html).toContain("json-tree__value--null");
  });

  it("keeps incomplete and fenced JSON on the existing text renderer", () => {
    const incomplete = renderToStaticMarkup(createElement(StructuredAgentMessage, {
      ...baseProps,
      complete: false,
      text: '{"status":"streaming"}',
    }));
    const fenced = renderToStaticMarkup(createElement(StructuredAgentMessage, {
      ...baseProps,
      text: '```json\n{"status":"done"}\n```',
    }));
    expect(incomplete).toContain('data-renderer="markdown"');
    expect(incomplete).not.toContain("structured-agent-message");
    expect(fenced).toContain('data-renderer="markdown"');
    expect(fenced).not.toContain("structured-agent-message");
  });
});
