import { describe, expect, it } from "vitest";
import { parseMarkdownLinks } from "./markdown-links";

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

  it("keeps relative paths and custom schemes as plain text", () => {
    const relative = "[报告](outputs/report.pdf)";
    const fileUrl = "[报告](file:///tmp/report.pdf)";
    expect(parseMarkdownLinks(relative)).toEqual([{ type: "text", value: relative }]);
    expect(parseMarkdownLinks(fileUrl)).toEqual([{ type: "text", value: fileUrl }]);
  });
});
