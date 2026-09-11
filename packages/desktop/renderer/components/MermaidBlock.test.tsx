import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MermaidBlock from "./MermaidBlock";
import { renderAssistantText } from "./ChatView";

describe("Mermaid message blocks", () => {
  it("routes a closed Mermaid fence to the diagram renderer, case insensitively", () => {
    const html = renderToStaticMarkup(renderAssistantText("前文\n```MeRmAiD\nflowchart TB\nA --> B\n```\n后文"));
    expect(html).toContain('class="mermaid-block"');
    expect(html).toContain("正在渲染图表");
    expect(html).toContain("前文");
    expect(html).toContain("后文");
  });

  it("keeps an unfinished streaming fence as escaped source", () => {
    const html = renderToStaticMarkup(renderAssistantText('```mermaid\nflowchart TB\nA["<script>alert(1)</script>"]'));
    expect(html).toContain("图表生成中");
    expect(html).not.toContain("正在渲染图表");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("preserves ordinary code fences without activating Mermaid", () => {
    const html = renderToStaticMarkup(renderAssistantText("```typescript\nconst diagram = 'mermaid';\n```"));
    expect(html).not.toContain('class="mermaid-block"');
    expect(html).toContain("typescript");
    expect(html).toContain("const diagram");
  });

  it("handles empty and multiple diagrams independently", () => {
    const empty = renderToStaticMarkup(createElement(MermaidBlock, { code: "", complete: true }));
    expect(empty).toContain("暂无图表内容");
    const html = renderToStaticMarkup(renderAssistantText("```mermaid\nflowchart TB\nA-->B\n```\n```mermaid\nsequenceDiagram\nA->>B: hi\n```"));
    expect(html.match(/class="mermaid-block"/g)).toHaveLength(2);
  });
});
