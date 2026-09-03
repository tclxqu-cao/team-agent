import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ReasoningSummary from "./ReasoningSummary";

const sections = [{ sectionIndex: 0, text: "**Inspecting message layout**\n\nMore detail" }];

describe("ReasoningSummary", () => {
  it("shows a clean one-line preview when collapsed", () => {
    const html = renderToStaticMarkup(createElement(ReasoningSummary, {
      sections,
      renderContent: (text: string) => text,
    }));

    expect(html).toContain("reasoning-summary__preview");
    expect(html).toContain("reasoning-summary__brain");
    expect(html).toContain("reasoning-summary__chevron");
    expect(html).toContain("思考");
    expect(html).toContain("Inspecting message layout");
    expect(html).not.toContain("持续了");
    expect(html).not.toContain("**Inspecting message layout**");
    expect(html).not.toContain("reasoning-summary__spinner");
  });

  it("expands only the actively streaming summary", () => {
    const html = renderToStaticMarkup(createElement(ReasoningSummary, {
      sections,
      streaming: true,
      startedAt: Date.now() - 3_000,
      renderContent: (text: string) => text,
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("reasoning-summary__content");
    expect(html).toContain("reasoning-summary__spinner");
    expect(html).toContain("思考中");
    expect(html).toContain("持续了 3 秒");
    expect(html).not.toContain("生成中");
    expect(html).not.toContain("reasoning-summary__preview");
  });
});
