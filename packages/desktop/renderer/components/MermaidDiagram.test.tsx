import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import MermaidDiagram from "./MermaidDiagram";

describe("Mermaid diagram controls", () => {
  it("exposes accessible zoom, fit, fullscreen, and PNG controls", () => {
    const html = renderToStaticMarkup(createElement(MermaidDiagram, { code: "flowchart TB\nA-->B", svg: '<svg viewBox="0 0 400 650"></svg>' }));
    for (const label of ["缩小图表", "放大图表", "自适应图表", "全屏查看图表", "导出图表 PNG", "点击全屏查看 Mermaid 图表"]) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    expect(html).toContain("双指缩放");
    expect(html).toContain('class="mermaid-diagram-canvas"');
    expect(html).toContain("data-tab-swipe-ignore");
  });

  it("bounds the mobile preview and uses a viewport-sized fullscreen overlay", () => {
    const css = readFileSync(new URL("./MermaidBlock.css", import.meta.url), "utf8");
    expect(css).toContain("touch-action: pan-x pan-y");
    expect(css).toContain("height: 100dvh");
    expect(css).toContain("overscroll-behavior: contain");
    expect(css).toContain("max-height: 420px");
    expect(css).toContain(".mermaid-diagram-canvas > svg");
    expect(css).toContain("width: 100% !important");
  });
});
