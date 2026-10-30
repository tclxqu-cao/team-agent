import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AgentWorkspaceSwitcher from "./AgentWorkspaceSwitcher";
import { AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import { AGENT_LABELS } from "../lib/agent-catalog";

describe("AgentWorkspaceSwitcher", () => {
  it("renders all eight independent Agent choices in stable order", () => {
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
    expect(html.match(/data-agent-icon=/g)).toHaveLength(8);
    expect(html).toContain('data-agent-icon="customer-agent"');
    expect(html).toContain('data-agent-icon="codex"');
    expect(html).toContain('data-agent-icon="claude-code"');
    expect(html).toContain('data-agent-icon="opencode"');
    expect(html).toContain('data-agent-icon="deepseek-harness"');
    for (const id of ["qoder", "zcode", "workbuddy"]) expect(html).toContain(`data-agent-icon="${id}"`);
    expect(html).not.toMatch(/>CA<|>CX<|>CC<|>OC</);
    expect(html).not.toMatch(/<i\b/);
  });

  it("omits per-Agent status dots from the vertical rail without removing availability hints", () => {
    const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, {
      value: "codex",
      health: [
        { agentType: "codex", available: true, label: "Codex" },
        { agentType: "opencode", available: false, label: "OpenCode", error: "not installed" },
      ],
      vertical: true,
      onChange: () => undefined,
      onUnavailable: () => undefined,
    }));

    expect(html).toContain('aria-orientation="vertical"');
    expect(html.match(/data-agent-icon=/g)).toHaveLength(8);
    expect(html).not.toMatch(/<i\b/);
    expect(html).toContain("远程未安装 OpenCode");
    expect(html).toContain('aria-disabled="true"');
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

  it("keeps every missing native Agent visible with a blocking hint in both layouts", () => {
    const nativeAgents = AGENT_TYPES.filter(agentType => agentType !== "customer-agent");
    const health = nativeAgents.map(agentType => ({ agentType, available: false, label: AGENT_LABELS[agentType], error: "not installed" }));
    for (const vertical of [false, true]) {
      const html = renderToStaticMarkup(createElement(AgentWorkspaceSwitcher, { value: "customer-agent", health, vertical, onChange: () => undefined, onUnavailable: () => undefined }));
      expect(html.match(/aria-disabled="true"/g)).toHaveLength(nativeAgents.length);
      for (const agentType of nativeAgents) expect(html).toContain(`远程未安装 ${AGENT_LABELS[agentType]}`);
      expect(html.match(/data-agent-icon=/g)).toHaveLength(AGENT_TYPES.length);
      expect(html).not.toMatch(/<i\b/);
      expect(html).not.toContain(' disabled=""');
    }
  });
});
