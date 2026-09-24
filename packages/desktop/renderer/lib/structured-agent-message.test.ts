import { describe, expect, it } from "vitest";
import {
  MAX_STRUCTURED_MESSAGE_CHARS,
  parseStructuredAgentMessage,
  suggestionLabel,
} from "./structured-agent-message";

describe("structured agent message parsing", () => {
  it("normalizes the portfolio-shaped envelope", () => {
    const parsed = parseStructuredAgentMessage(JSON.stringify({
      schemaVersion: 1,
      skill: "portfolio-chat",
      title: "关于工作经历",
      summary: "公开信息",
      blocks: [
        { type: "text", text: "正文", tone: "body" },
        { type: "html", html: "<script>alert(1)</script>" },
        { type: "text", text: "" },
      ],
      suggestions: [" /whoami ", 1, "/works"],
      sources: ["public/profile.md", null],
      generatedAt: "2026-09-24T14:44:48+08:00",
    }));

    expect(parsed).toMatchObject({
      kind: "envelope",
      value: {
        schemaVersion: 1,
        skill: "portfolio-chat",
        title: "关于工作经历",
        summary: "公开信息",
        suggestions: ["/whoami", "/works"],
        sources: ["public/profile.md"],
        blocks: [
          { kind: "text", text: "正文", tone: "body" },
          { kind: "unknown", blockType: "html" },
          { kind: "unknown", blockType: "text" },
        ],
      },
    });
  });

  it("keeps unknown objects and root arrays as generic JSON", () => {
    expect(parseStructuredAgentMessage('{"status":"ok","nested":{"count":2}}')).toMatchObject({
      kind: "json",
      value: { status: "ok", nested: { count: 2 } },
    });
    expect(parseStructuredAgentMessage('[1,true,null,{"name":"test"}]')).toMatchObject({
      kind: "json",
      value: [1, true, null, { name: "test" }],
    });
  });

  it("falls back for non-whole, fenced, scalar, incomplete, and oversized JSON", () => {
    expect(parseStructuredAgentMessage('result: {"ok":true}')).toBeNull();
    expect(parseStructuredAgentMessage('```json\n{"ok":true}\n```')).toBeNull();
    expect(parseStructuredAgentMessage('"plain"')).toBeNull();
    expect(parseStructuredAgentMessage('{"ok":true}', false)).toBeNull();
    expect(parseStructuredAgentMessage(`{"value":"${"x".repeat(MAX_STRUCTURED_MESSAGE_CHARS)}"}`)).toBeNull();
    expect(parseStructuredAgentMessage('{"ok":')).toBeNull();
  });

  it("limits list fields without rejecting otherwise valid content", () => {
    const parsed = parseStructuredAgentMessage(JSON.stringify({
      schemaVersion: 1,
      title: "Limits",
      blocks: Array.from({ length: 30 }, (_, index) => ({ type: "text", text: String(index) })),
      suggestions: Array.from({ length: 20 }, (_, index) => `/item-${index}`),
      sources: Array.from({ length: 40 }, (_, index) => `source-${index}.md`),
    }));
    expect(parsed?.kind).toBe("envelope");
    if (parsed?.kind !== "envelope") return;
    expect(parsed.value.blocks).toHaveLength(24);
    expect(parsed.value.suggestions).toHaveLength(12);
    expect(parsed.value.sources).toHaveLength(30);
  });
});

describe("suggestion labels", () => {
  it.each([
    ["/help", "使用帮助"],
    ["/whoami", "关于我"],
    ["/works", "项目与作品"],
    ["/jobs", "求职信息"],
    ["/timeline", "经历时间线"],
    ["/contact", "联系方式"],
    ["/project agentroam", "查看项目：agentroam"],
    ["/custom", "/custom"],
  ])("labels %s as %s", (command, label) => {
    expect(suggestionLabel(command)).toBe(label);
  });
});
