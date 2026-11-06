import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ParallelAgentTabs from "./ParallelAgentTabs";

describe("compact Agent result tabs", () => {
  it("shows brand icons and status dots while retaining accessible names", () => {
    const html = renderToStaticMarkup(<ParallelAgentTabs members={[
      { id: "a", agentType: "codex", status: "completed" }, { id: "b", agentType: "zcode", status: "needs-input" },
    ]} selectedId="a" onSelect={() => undefined} />);
    expect(html).toContain('aria-label="Codex · 已完成"');
    expect(html).toContain('aria-label="ZCode · 待确认"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('parallel-agent-status is-needs-input');
    expect(html).not.toContain('>已完成<');
    expect(html).not.toContain('>Codex<');
  });
});
