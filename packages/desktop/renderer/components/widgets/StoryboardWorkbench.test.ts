import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StoryboardWorkbench } from "./StoryboardWorkbench";

describe("StoryboardWorkbench run completion", () => {
  it("stops claiming generation is active when the agent turn has ended", () => {
    const props = {
      status: "generating",
      shots: [{ index: 1, description: "分镜", prompt: "scene", duration: 5, status: "pending" as const }],
    };
    const active = renderToStaticMarkup(createElement(StoryboardWorkbench, { ...props, isAgentRunning: true }));
    const ended = renderToStaticMarkup(createElement(StoryboardWorkbench, { ...props, isAgentRunning: false }));
    expect(active).toContain("生成中...");
    expect(ended).toContain("本轮已结束");
    expect(ended).not.toContain("生成中...");
    expect(ended).not.toContain("合成完成");
  });

  it("preserves an explicitly completed artifact status", () => {
    const html = renderToStaticMarkup(createElement(StoryboardWorkbench, { status: "composed", isAgentRunning: false }));
    expect(html).toContain("合成完成");
  });
});
