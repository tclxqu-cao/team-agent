import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import EmptySessionWelcome, {
  EMPTY_SESSION_STARTERS,
  welcomeGreetingForHour,
} from "./EmptySessionWelcome";

const source = readFileSync(new URL("./EmptySessionWelcome.tsx", import.meta.url), "utf8");
const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

describe("EmptySessionWelcome", () => {
  it("renders a personable ready state with three editable starters", () => {
    const html = renderToStaticMarkup(createElement(EmptySessionWelcome, {
      agentType: "codex",
      ready: true,
      now: new Date(2026, 8, 12, 10, 0, 0),
      onSelectPrompt: vi.fn(),
    }));

    expect(html).toContain("上午好。");
    expect(html).toContain("今天想一起做点什么？");
    expect(html).toContain("Codex · 已准备好");
    for (const starter of EMPTY_SESSION_STARTERS) expect(html).toContain(starter.prompt);
    expect(html.match(/data-prompt=/g)).toHaveLength(3);
    expect(html).not.toContain("disabled");
  });

  it("greets by time of day, including a late-night nudge", () => {
    const renderAt = (hour: number, ready = true) => renderToStaticMarkup(
      createElement(EmptySessionWelcome, {
        agentType: "codex",
        ready,
        now: new Date(2026, 8, 12, hour, 0, 0),
        onSelectPrompt: vi.fn(),
      }),
    );

    expect(renderAt(1)).toContain("夜深了。");
    expect(renderAt(1)).toContain("注意休息，重要的事可以先留给我。");
    expect(renderAt(6)).toContain("早啊。");
    expect(renderAt(13)).toContain("中午好。");
    expect(renderAt(15)).toContain("下午好。");
    expect(renderAt(21)).toContain("晚上好。");
    // 未就绪时时段问候退位给配置引导，但标题仍跟时间走。
    expect(renderAt(1, false)).toContain("夜深了。");
    expect(renderAt(1, false)).toContain("配置好 API Key 后，我就能开始。");
  });

  it("keeps every hour bucket covered with distinct titles", () => {
    const titles = new Set(
      Array.from({ length: 24 }, (_, hour) => welcomeGreetingForHour(hour).title),
    );
    expect(titles.size).toBeGreaterThanOrEqual(5);
    for (const hour of [0, 2, 4, 23]) {
      expect(welcomeGreetingForHour(hour).title).toBe("夜深了。");
    }
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
