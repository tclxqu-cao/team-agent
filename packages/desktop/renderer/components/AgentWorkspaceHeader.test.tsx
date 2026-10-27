import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import { AGENT_LABELS } from "../lib/agent-catalog";
import AgentWorkspaceHeader from "./AgentWorkspaceHeader";

describe("single Agent workspace header", () => {
  it("separates the session list with spacing instead of a horizontal rule", () => {
    const css = readFileSync(new URL("../styles/sidebar-navigation.css", import.meta.url), "utf8");
    const header = css.match(/^\.sidebar-agent-header \{([^}]+)\}/m)?.[1];
    expect(header).toContain("border-bottom: 0;");
    expect(css).toContain("margin-top: 12px;");
  });

  it.each(AGENT_TYPES)("renders one identity for %s without duplicating application actions", value => {
    const html = renderToStaticMarkup(createElement(AgentWorkspaceHeader, {
      value, health: [{ agentType: value, label: AGENT_LABELS[value], available: true }],
      onClose: () => {},
    }));
    expect(html).toContain(`data-agent-icon="${value}"`);
    expect(html).toContain(AGENT_LABELS[value]);
    expect(html).not.toContain("header-action-menu-trigger");
    expect(html).toContain('aria-label="收起会话列表"');
    expect(html).toContain("is-ready");
    expect(html).not.toContain("通用任务");
  });

  it("distinguishes checking from an unavailable native runtime", () => {
    const render = (health: Parameters<typeof AgentWorkspaceHeader>[0]["health"]) => renderToStaticMarkup(createElement(AgentWorkspaceHeader, { value: "qoder", health, onClose: () => {} }));
    expect(render([])).toContain("is-checking");
    expect(render([{ agentType: "qoder", label: "Qoder", available: false, error: "not installed" }])).toContain("is-unavailable");
  });
});
import { readFileSync } from "node:fs";
