import { describe, expect, it } from "vitest";
import { parseMarkdownLinks, parseRichInlineTokens } from "./markdown-links";

describe("parseMarkdownLinks", () => {
  it("turns Chinese Markdown labels into links and preserves surrounding text", () => {
    const href = "http://git.17usoft.com/refund/merge_requests/new?merge_request%5Bsource_branch%5D=feature_req_326875&merge_request%5Btarget_branch%5D=develop";

    expect(parseMarkdownLinks(`请点击[创建目标为 develop 的 Merge Request](${href})。`)).toEqual([
      { type: "text", value: "请点击" },
      { type: "link", label: "创建目标为 develop 的 Merge Request", href },
      { type: "text", value: "。" },
    ]);
  });

  it("keeps unsupported protocols as plain text", () => {
    const text = "[不要点击](javascript:alert(1))";
    expect(parseMarkdownLinks(text)).toEqual([{ type: "text", value: text }]);
  });

  it("supports multiple secure links in one line", () => {
    expect(parseMarkdownLinks("[文档](https://example.com/docs) 与 [工单](http://example.com/ticket)")).toEqual([
      { type: "link", label: "文档", href: "https://example.com/docs" },
      { type: "text", value: " 与 " },
      { type: "link", label: "工单", href: "http://example.com/ticket" },
    ]);
  });

  it("parses absolute artifact paths and trailing line numbers", () => {
    expect(parseMarkdownLinks("交付物：[报告](/Users/caoqu/project/outputs/report.pdf) 与 [源码](/Users/caoqu/project/src/main.ts:120)"))
      .toEqual([
        { type: "text", value: "交付物：" },
        {
          type: "artifact",
          label: "报告",
          path: "/Users/caoqu/project/outputs/report.pdf",
          raw: "[报告](/Users/caoqu/project/outputs/report.pdf)",
        },
        { type: "text", value: " 与 " },
        {
          type: "artifact",
          label: "源码",
          path: "/Users/caoqu/project/src/main.ts",
          line: 120,
          raw: "[源码](/Users/caoqu/project/src/main.ts:120)",
        },
      ]);
  });

  it("supports spaces in an absolute artifact path", () => {
    expect(parseMarkdownLinks("[演示文稿](/Users/caoqu/My Project/demo deck.pptx)")).toEqual([{
      type: "artifact",
      label: "演示文稿",
      path: "/Users/caoqu/My Project/demo deck.pptx",
      raw: "[演示文稿](/Users/caoqu/My Project/demo deck.pptx)",
    }]);
  });

  it("parses a code-styled artifact label with whitespace before the absolute path", () => {
    const raw = "[`111c424`]( /Users/caoqu/team-agent/customer-agent/docs/superpowers/specs/archive-design.md)";

    expect(parseRichInlineTokens(`设计规格已写入并单独提交：${raw}。`)).toEqual([
      { type: "text", value: "设计规格已写入并单独提交：" },
      {
        type: "artifact",
        label: "`111c424`",
        path: "/Users/caoqu/team-agent/customer-agent/docs/superpowers/specs/archive-design.md",
        raw,
      },
      { type: "text", value: "。" },
    ]);
  });

  it("does not parse an artifact-looking value inside inline code", () => {
    expect(parseRichInlineTokens("示例：`[报告](/tmp/report.md)`")).toEqual([
      { type: "text", value: "示例：" },
      { type: "code", value: "[报告](/tmp/report.md)" },
    ]);
  });

  it("parses Codex file citations as local artifacts", () => {
    const path = "/Users/caoqu/Documents/Codex/outputs/自主移动机器人_中英综合版.pptx";
    const raw = `:codex-file-citation{path="${path}" purpose="output"}`;

    expect(parseMarkdownLinks(`交付物：${raw}`)).toEqual([
      { type: "text", value: "交付物：" },
      {
        type: "artifact",
        label: "自主移动机器人_中英综合版.pptx",
        path,
        raw,
      },
    ]);
  });

  it("keeps unsafe or malformed Codex file citations as plain text", () => {
    const relative = ':codex-file-citation{path="outputs/report.pptx" purpose="output"}';
    const unknownAttribute = ':codex-file-citation{path="/tmp/report.pptx" target="output"}';

    expect(parseMarkdownLinks(relative)).toEqual([{ type: "text", value: relative }]);
    expect(parseMarkdownLinks(unknownAttribute)).toEqual([{ type: "text", value: unknownAttribute }]);
  });

  it("parses Codex visualize markers as local artifacts", () => {
    const raw = '\uE200visualize\uE202{"path":"/tmp/demo.html","mode":"wide","title":"原型图"}\uE201';

    expect(parseRichInlineTokens(`交付物：${raw}`)).toEqual([
      { type: "text", value: "交付物：" },
      {
        type: "artifact",
        label: "原型图",
        path: "/tmp/demo.html",
        raw,
      },
    ]);
  });

  it("uses the visualize artifact basename when its title is missing or blank", () => {
    const missingTitle = '\uE200visualize\uE202{"path":"/tmp/first-demo.html","mode":"wide"}\uE201';
    const blankTitle = '\uE200visualize\uE202{"path":"/tmp/second-demo.html","title":"  "}\uE201';

    expect(parseRichInlineTokens(`${missingTitle} ${blankTitle}`)).toEqual([
      {
        type: "artifact",
        label: "first-demo.html",
        path: "/tmp/first-demo.html",
        raw: missingTitle,
      },
      { type: "text", value: " " },
      {
        type: "artifact",
        label: "second-demo.html",
        path: "/tmp/second-demo.html",
        raw: blankTitle,
      },
    ]);
  });

  it.each([
    '\uE200visualize\uE202{broken}\uE201',
    '\uE200visualize\uE202{"path":"outputs/demo.html","title":"原型图"}\uE201',
    '\uE200visualize\uE202{"path":"/tmp/demo.html?download=1","title":"原型图"}\uE201',
    '\uE200visualize\uE202{"path":"/tmp/demo.html#preview","title":"原型图"}\uE201',
    '\uE200visualize\uE202{"path":"/tmp/demo.html","title":42}\uE201',
    '\uE200visualize\uE202{"path":"/tmp/demo.html","mode":true}\uE201',
  ])("keeps an invalid Codex visualize marker as plain text", (raw) => {
    expect(parseRichInlineTokens(raw)).toEqual([{ type: "text", value: raw }]);
  });

  it("does not parse a Codex visualize marker inside inline code", () => {
    const raw = '\uE200visualize\uE202{"path":"/tmp/demo.html","title":"原型图"}\uE201';
    expect(parseRichInlineTokens(`\`${raw}\``)).toEqual([{ type: "code", value: raw }]);
  });

  it("keeps relative paths and custom schemes as plain text", () => {
    const relative = "[报告](outputs/report.pdf)";
    const fileUrl = "[报告](file:///tmp/report.pdf)";
    expect(parseMarkdownLinks(relative)).toEqual([{ type: "text", value: relative }]);
    expect(parseMarkdownLinks(fileUrl)).toEqual([{ type: "text", value: fileUrl }]);
  });
});
