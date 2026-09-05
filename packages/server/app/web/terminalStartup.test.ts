import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const paneSource = readFileSync(new URL("./TerminalPane.tsx", import.meta.url), "utf8");
const pageSource = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("web terminal startup feedback", () => {
  it("becomes ready from either the start response or the matching event", () => {
    expect(paneSource).toContain('onEvent("term:ready"');
    expect(paneSource).toContain("message.id === sessionId.current");
    expect(paneSource).toContain("if (res.ready) setSessionReady(true)");
    expect(paneSource).not.toContain("setSessionReady(res.ready)");
  });

  it("keeps xterm mounted behind a polite loading state", () => {
    expect(paneSource).toContain('className="terminal-surface"');
    expect(paneSource).toContain('className="terminal-screen"');
    expect(paneSource).toContain('className="terminal-boot" role="status" aria-live="polite"');
    expect(paneSource).toContain("正在启动终端");
    expect(pageSource).toMatch(/\.terminal-surface\s*\{[^}]*min-height:90px/);
  });

  it("reveals slow terminal output after eight seconds with a non-blocking warning", () => {
    expect(paneSource).toContain("8_000");
    expect(paneSource).toContain("setStartupTimedOut(true)");
    expect(paneSource).toContain("终端初始化较慢");
    expect(pageSource).toMatch(/\.terminal-boot-warning\s*\{[^}]*pointer-events:none/);
    expect(pageSource).toContain(".terminal-boot-spinner { animation:none !important; }");
  });
});
