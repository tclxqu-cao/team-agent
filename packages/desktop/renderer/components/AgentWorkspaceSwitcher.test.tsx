import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentWorkspaceSwitcher from "./AgentWorkspaceSwitcher";
import { AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import { AGENT_LABELS } from "../lib/agent-catalog";

describe("AgentWorkspaceSwitcher", () => {
  const onChange = () => undefined;

  it("renders available Agent choices in stable order with their product icons", () => {
    const health = AGENT_TYPES.map(agentType => ({ agentType, available: true, label: AGENT_LABELS[agentType] }));
    const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, { value: "grok", health, onChange }));

    expect(html.indexOf("Customer Agent")).toBeLessThan(html.indexOf("Codex"));
    expect(html.indexOf("Codex")).toBeLessThan(html.indexOf("Claude Code"));
    expect(html).toContain('aria-selected="true" aria-label="Grok CLI"');
    expect(html.match(/data-agent-icon=/g)).toHaveLength(AGENT_TYPES.length);
    for (const type of ["grok", "agy"]) expect(html).toMatch(new RegExp(`data-agent-icon="${type}"[^>]+src="[^"]+/${type}\\.png"`));
    expect(html).not.toMatch(/<i\b/);
  });

  it.each([false, true])("hides missing or unavailable remote Agents in either layout (vertical=%s)", vertical => {
    const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, {
      value: "codex", vertical, onChange,
      health: [
        { agentType: "codex", available: true, label: "Codex" },
        { agentType: "opencode", available: false, label: "OpenCode", error: "not installed" },
        { agentType: "grok", available: false, label: "Grok CLI", error: "unavailable" },
      ],
    }));

    expect(html).toContain('aria-label="Customer Agent"');
    expect(html).toContain('aria-label="Codex"');
    expect(html.match(/data-agent-icon=/g)).toHaveLength(2);
    expect(html).not.toMatch(/OpenCode|Grok CLI|Antigravity CLI|aria-disabled/);
  });
});
