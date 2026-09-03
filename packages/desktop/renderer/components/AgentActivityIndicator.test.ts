import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentActivityIndicator from "./AgentActivityIndicator";

describe("AgentActivityIndicator", () => {
  it("renders only the localized model activity label", () => {
    const html = renderToStaticMarkup(createElement(AgentActivityIndicator, {
      startedAt: Date.now() - 2_000,
    }));

    expect(html).toContain("思考中");
    expect(html).toContain("持续了 2 秒");
    expect(html).toContain("agent-activity-icon");
    expect(html).not.toContain("Iteration");
    expect(html).not.toContain("思考过程");
    expect(html).not.toContain("工具执行中");
  });
});
