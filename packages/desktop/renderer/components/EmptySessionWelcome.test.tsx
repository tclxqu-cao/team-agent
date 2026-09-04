import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import EmptySessionWelcome, { EMPTY_SESSION_STARTERS } from "./EmptySessionWelcome";

const source = readFileSync(new URL("./EmptySessionWelcome.tsx", import.meta.url), "utf8");
const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

describe("EmptySessionWelcome", () => {
  it("renders a personable ready state with three editable starters", () => {
    const html = renderToStaticMarkup(createElement(EmptySessionWelcome, {
      agentType: "codex",
      ready: true,
      onSelectPrompt: vi.fn(),
    }));

    expect(html).toContain("嗨，我在。");
    expect(html).toContain("今天想一起做点什么？");
    expect(html).toContain("Codex · 已准备好");
    for (const starter of EMPTY_SESSION_STARTERS) expect(html).toContain(starter.prompt);
    expect(html.match(/data-prompt=/g)).toHaveLength(3);
    expect(html).not.toContain("disabled");
  });

  it("shows configuration guidance and disables starters when unavailable", () => {
    const html = renderToStaticMarkup(createElement(EmptySessionWelcome, {
      agentType: "customer-agent",
      ready: false,
      onSelectPrompt: vi.fn(),
    }));

    expect(html).toContain("Customer Agent · 等待配置");
    expect(html).toContain("配置好 API Key 后，我就能开始。");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
  });

  it.each([
    ["customer-agent", "Customer Agent"],
    ["codex", "Codex"],
    ["claude-code", "Claude Code"],
    ["opencode", "OpenCode"],
  ] as const)("uses the active %s runtime label", (agentType, label) => {
    const html = renderToStaticMarkup(createElement(EmptySessionWelcome, {
      agentType,
      ready: true,
      onSelectPrompt: vi.fn(),
    }));

    expect(html).toContain(`${label} · 已准备好`);
  });

  it("connects the shared empty state to the composer without auto-submit", () => {
    expect(app).toContain("activeAgentType={activeAgent}");
    expect(chatView).toContain('key={viewSessionId ?? "initial-empty-session"}');
    expect(chatView).toContain("onSelectPrompt={selectStarterPrompt}");
    expect(chatView).toContain("handleComposerChange(prompt);");
    expect(chatView).toContain("inputRef.current?.focus()");
    expect(source).toContain("onClick={() => onSelectPrompt(prompt)}");
    expect(source).not.toContain("handleSend");
  });

  it("keeps the activation finite and provides a reduced-motion state", () => {
    expect(css).toContain("@keyframes empty-session-core-enter");
    expect(css).toContain("@keyframes empty-session-orbit-outer");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).not.toMatch(/empty-session[^;{}]*animation[^;{}]*infinite/);
  });
});
