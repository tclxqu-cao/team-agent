import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentWorkspaceSwitcher from "./AgentWorkspaceSwitcher";

describe("AgentWorkspaceSwitcher", () => {
  it("renders the five independent Agent choices in stable order", () => {
    const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, {
      value: "codex",
      health: [],
      onChange: () => undefined,
      onUnavailable: () => undefined,
    }));

    expect(html.indexOf("Customer Agent")).toBeLessThan(html.indexOf("Codex"));
    expect(html.indexOf("Codex")).toBeLessThan(html.indexOf("Claude Code"));
    expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("OpenCode"));
    expect(html.indexOf("OpenCode")).toBeLessThan(html.indexOf("DeepSeek Harness"));
    expect(html).toContain('aria-label="Codex"');
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/data-agent-icon=/g)).toHaveLength(5);
    expect(html).toContain('data-agent-icon="customer-agent"');
    expect(html).toContain('data-agent-icon="codex"');
    expect(html).toContain('data-agent-icon="claude-code"');
    expect(html).toContain('data-agent-icon="opencode"');
    expect(html).toContain('data-agent-icon="deepseek-harness"');
    expect(html).not.toMatch(/>CA<|>CX<|>CC<|>OC</);
  });

  it("marks a missing remote Agent unavailable and exposes the reason", () => {
    const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, {
      value: "customer-agent",
      health: [{ agentType: "codex", available: false, label: "Codex", error: "未安装" }],
      onChange: () => undefined,
      onUnavailable: () => undefined,
    }));

    expect(html).toContain("远程未安装 Codex");
    expect(html).toContain('class="is-unavailable"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain(' disabled=""');
  });
});
