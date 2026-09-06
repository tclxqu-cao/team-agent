import { describe, expect, it } from "vitest";
import {
  MAX_MARKDOWN_PREVIEW_BYTES,
  isMarkdownPreviewPath,
  renderMarkdownPreviewDocument,
} from "./markdown-preview.mjs";

describe("Markdown preview document", () => {
  it.each(["README.md", "guide.MARKDOWN", "note.mdown", "note.mkdn", "page.mdx"])(
    "recognizes %s as Markdown",
    (filePath) => expect(isMarkdownPreviewPath(filePath)).toBe(true),
  );

  it("leaves non-Markdown files on their existing preview path", () => {
    expect(isMarkdownPreviewPath("page.html")).toBe(false);
    expect(isMarkdownPreviewPath("data.json")).toBe(false);
  });

  it("renders common GFM content into a responsive standalone document", () => {
    const rendered = renderMarkdownPreviewDocument([
      "# Preview",
      "",
      "- [x] complete",
      "",
      "| Name | Value |",
      "| --- | --- |",
      "| one | two |",
      "",
      "```ts",
      "const ready = true;",
      "```",
      "",
      "![diagram](images/diagram.png)",
    ].join("\n"), { title: "README.md" });

    expect(rendered).toContain("<!doctype html>");
    expect(rendered).toContain("<h1>Preview</h1>");
    expect(rendered).toMatch(/<input(?=[^>]*type="checkbox")(?=[^>]*checked="")(?=[^>]*disabled="")[^>]*>/);
    expect(rendered).toContain("<table>");
    expect(rendered).toContain('<pre><code class="language-ts">');
    expect(rendered).toContain('src="images/diagram.png"');
    expect(rendered).toContain("overflow-x: auto");
    expect(rendered).toContain("@media (max-width: 520px)");
    expect(MAX_MARKDOWN_PREVIEW_BYTES).toBe(8 * 1024 * 1024);
  });

  it("escapes document titles and embedded raw HTML", () => {
    const rendered = renderMarkdownPreviewDocument(
      '<script>alert(1)</script>\n<div onclick="alert(2)">unsafe</div>',
      { title: '<img src=x onerror="alert(3)">' },
    );

    expect(rendered).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rendered).toContain("&lt;div onclick=&quot;alert(2)&quot;&gt;unsafe&lt;/div&gt;");
    expect(rendered).toContain("<title>&lt;img src=x onerror=&quot;alert(3)&quot;&gt;</title>");
    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("<div onclick=");
  });
});
