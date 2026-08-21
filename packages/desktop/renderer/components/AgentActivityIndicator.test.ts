import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentActivityIndicator from "./AgentActivityIndicator";

describe("AgentActivityIndicator", () => {
  it("renders only the localized model activity label", () => {
    const html = renderToStaticMarkup(createElement(AgentActivityIndicator, { activity: "thinking" }));

    expect(html).toContain("思考中");
    expect(html).not.toContain("Iteration");
    expect(html).not.toContain("思考过程");
  });

  it("renders the tool activity label", () => {
    const html = renderToStaticMarkup(createElement(AgentActivityIndicator, { activity: "tools" }));

    expect(html).toContain("工具执行中");
  });
});
