import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CollaborationMessageText from "./CollaborationMessageText";

const render = (text: string) => renderToStaticMarkup(createElement(CollaborationMessageText, { text, cwd: "/Users/caoqu/test" }));

describe("collaboration message file previews", () => {
  it("recognizes the bare report paths posted by group members", () => {
    for (const name of ["codex", "claude-code", "deepseek-harness", "customer-agent"]) {
      const path = `/Users/caoqu/test/${name}.md`;
      const html = render(path);
      expect(html).toContain('class="collab-message-path"');
      expect(html).toContain(`title="${path}"`);
      expect(html).toContain(`aria-label="查看文件：${path}"`);
    }
  });

  it("keeps Markdown, home, inline-code and Windows paths actionable without line numbers in the file target", () => {
    const html = render("[报告](report.md)\n`/Users/caoqu/My Project/report.md`\n~/reports/final.pdf\nC:\\work\\report.md:12");
    expect(html).toContain('title="/Users/caoqu/test/report.md"');
    expect(html).toContain('title="/Users/caoqu/My Project/report.md"');
    expect(html).toContain('title="~/reports/final.pdf"');
    expect(html).toContain('title="C:\\work\\report.md:12"');
    expect(html.match(/class="collab-message-path"/g)).toHaveLength(4);
  });

  it("preserves external links and escapes message text while rejecting unsupported schemes", () => {
    const html = render("[文档](https://example.com/docs)\n[危险](javascript:alert(1))\n<script>alert(1)</script>");
    expect(html).toContain('href="https://example.com/docs"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain('class="collab-message-path"');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("&lt;script&gt;");
  });
});
