import { describe, expect, it } from "vitest";
import { codePreviewLanguage, MAX_HIGHLIGHT_CHARACTERS, MAX_HIGHLIGHT_LINE_LENGTH } from "./codePreviewLanguage";
import { highlightCode } from "./codeSyntax";

describe("file preview syntax highlighting", () => {
  it("distinguishes Java keywords, annotations, strings and comments", () => {
    const markup = highlightCode("/src/Controller.java", '// 查询历史\n@RestController\npublic class Controller { String name = "历史"; }');
    expect(markup).toContain('class="hljs-keyword">public');
    expect(markup).toContain('class="hljs-meta">@RestController');
    expect(markup).toContain('class="hljs-string">&quot;历史&quot;');
    expect(markup).toContain('class="hljs-comment">// 查询历史');
  });

  it("recognizes typed JSX and JSON without guessing the language from content", () => {
    expect(highlightCode("/src/App.tsx", 'const label: string = "你好"; const view = <div>{label}</div>;')).toContain('class="hljs-tag"');
    expect(highlightCode("/data.JSON", '{"enabled": true, "count": 42}')).toContain('class="hljs-attr"');
    expect(highlightCode("/notes.txt", "public class Notes {}")).toBeNull();
    expect(codePreviewLanguage("/dir.java/notes")).toBeNull();
    expect(codePreviewLanguage("/config/.env.production")).toBe("ini");
    expect(codePreviewLanguage("/config/Dockerfile.dev")).toBe("dockerfile");
  });

  it("escapes file markup so source tags and handlers cannot run", () => {
    const markup = highlightCode("/page.html", '<script>alert("x")</script><img src=x onerror="alert(1)"><!-- & -->');
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("&lt;");
    expect(markup).toContain("&gt;");
    expect(markup).toContain("&amp;");
  });

  it("preserves syntax context across progressively loaded chunks", () => {
    const chunks = ['/* 第一块\npublic class ', '仍然是注释 */\npublic class Example {}'];
    const markup = highlightCode("/Example.java", chunks.join(""));
    expect(markup).toContain('class="hljs-comment">/* 第一块\npublic class 仍然是注释 */');
    expect(markup?.match(/class="hljs-keyword">public/g)).toHaveLength(1);
  });

  it("keeps oversized sources and long generated lines in plain text", () => {
    expect(highlightCode("/large.java", "x".repeat(MAX_HIGHLIGHT_CHARACTERS + 1))).toBeNull();
    expect(highlightCode("/min.js", "x".repeat(MAX_HIGHLIGHT_LINE_LENGTH + 1))).toBeNull();
  });
});
