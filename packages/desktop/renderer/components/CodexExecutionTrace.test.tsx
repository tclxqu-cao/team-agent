import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CodexExecutionTrace from "./CodexExecutionTrace";

const source = readFileSync(new URL("./CodexExecutionTrace.tsx", import.meta.url), "utf8");

describe("CodexExecutionTrace", () => {
  it("renders one collapsed idle row without requesting trace data", () => {
    const loadTrace = vi.fn(async () => []);
    const html = renderToStaticMarkup(createElement(CodexExecutionTrace, {
      trace: { turnId: "turn-1", revision: "rev-1" },
      loadTrace,
      loadToolResult: vi.fn(),
      renderContent: (text: string) => text,
      runtimeProgress: [],
      nativeSubagents: {},
    }));

    expect(loadTrace).not.toHaveBeenCalled();
    expect(html).toContain("执行过程");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("codex-execution-trace__body");
  });

  it("loads on expansion, reuses loaded messages, and exposes retry state", () => {
    expect(source).toContain("if (next && !hasMessages) void ensureLoaded()");
    expect(source).toContain("if (liveMessages.length > 0) return liveMessages");
    expect(source).toContain("if (pendingRef.current) return pendingRef.current");
    expect(source).toContain("setMessages(loaded)");
    expect(source).toContain("重新加载执行过程");
    expect(source).toContain("`执行过程 · ${itemCount} 项`");
  });

  it("renders live execution immediately without requesting a trace snapshot", () => {
    const loadTrace = vi.fn(async () => []);
    const html = renderToStaticMarkup(createElement(CodexExecutionTrace, {
      trace: {
        turnId: "turn-1",
        revision: "live:turn-1",
        liveMessages: [{
          id: "live-tool",
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "pwd" }, result: "/repo" }],
          timestamp: 1,
        }],
      },
      loadTrace,
      loadToolResult: vi.fn(),
      renderContent: (text: string) => text,
      runtimeProgress: [],
      nativeSubagents: {},
    }));

    expect(loadTrace).not.toHaveBeenCalled();
    expect(html).toContain("执行过程 · 1 项");
  });
});
