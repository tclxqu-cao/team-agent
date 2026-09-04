import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentWorkspaceSwitcher from "./AgentWorkspaceSwitcher";

describe("AgentWorkspaceSwitcher", () => {
  it("renders the four independent Agent choices in stable order", () => {
    const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, {
      value: "codex",
      health: [],
      onChange: () => undefined,
    }));

    expect(html.indexOf("Customer Agent")).toBeLessThan(html.indexOf("Codex"));
    expect(html.indexOf("Codex")).toBeLessThan(html.indexOf("Claude Code"));
    expect(html.indexOf("Claude Code")).toBeLessThan(html.indexOf("OpenCode"));
    expect(html).toContain('aria-label="Codex"');
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/data-agent-icon=/g)).toHaveLength(4);
    expect(html).toContain('data-agent-icon="customer-agent"');
    expect(html).toContain('data-agent-icon="codex"');
    expect(html).toContain('data-agent-icon="claude-code"');
    expect(html).toContain('data-agent-icon="opencode"');
    expect(html).not.toMatch(/>CA<|>CX<|>CC<|>OC</);
  });

  it("keeps an unavailable Agent selectable while exposing its status", () => {
    const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, {
      value: "customer-agent",
      health: [{ agentType: "codex", available: false, label: "Codex", error: "未安装" }],
      onChange: () => undefined,
    }));

    expect(html).toContain("Codex 不可用：未安装");
    expect(html).toContain('class="is-unavailable"');
    expect(html).not.toContain("disabled");
  });
});
