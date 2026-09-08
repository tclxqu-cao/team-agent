import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CodexExecutionTrace, { CodexExecutionTraceContent } from "./CodexExecutionTrace";

const source = readFileSync(new URL("./CodexExecutionTrace.tsx", import.meta.url), "utf8");

describe("CodexExecutionTrace", () => {
  it("renders one lazy history action without requesting trace data", () => {
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
    expect(html).toContain("查看执行过程");
    expect(html).toContain("codex-execution-trace__load");
    expect(html).not.toContain("codex-execution-trace__timeline");
  });

  it("shows an inline session loader on the first auto-load frame", () => {
    const loadTrace = vi.fn(async () => []);
    const html = renderToStaticMarkup(createElement(CodexExecutionTrace, {
      trace: { turnId: "turn-latest", revision: "rev-latest" },
      loadTrace,
      loadToolResult: vi.fn(),
      renderContent: (text: string) => text,
      runtimeProgress: [],
      nativeSubagents: {},
      autoLoad: true,
    }));

    expect(loadTrace).not.toHaveBeenCalled();
    expect(html).toContain('class="codex-execution-trace__status"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在加载会话");
    expect(html).not.toContain("查看执行过程");
    expect(html).not.toContain("<button");
  });

  it("loads on demand, reuses loaded messages, and exposes retry state", () => {
    expect(source).toContain("onClick={() => void ensureLoaded().catch(() => undefined)}");
    expect(source).toContain("if (!force && liveMessages.length > 0) return liveMessages");
    expect(source).toContain("if (pendingRef.current) return pendingRef.current");
    expect(source).toContain("setMessages(loaded)");
    expect(source).toContain("重新加载执行过程");
    expect(source).not.toContain("codexExecutionItemCount");
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
    expect(html).toContain("codex-execution-trace__timeline");
    expect(html).toContain("终端");
    expect(html).toContain("pwd");
    expect(html).not.toContain("查看执行过程");
  });

  it("renders commentary text inside the execution timeline", () => {
    const html = renderToStaticMarkup(createElement(CodexExecutionTraceContent, {
      messages: [{
        id: "commentary-1",
        role: "assistant",
        content: "正在检查项目文件",
        presentation: { agentMessagePhase: "commentary" },
        timestamp: 1,
      }],
      renderContent: (text: string) => text,
      runtimeProgress: [],
      nativeSubagents: {},
      enableFilePreview: false,
      onLoadResult: vi.fn(),
    }));

    expect(html).toContain("codex-execution-trace__commentary");
    expect(html).toContain("正在检查项目文件");
  });

  it("groups adjacent terminal calls without restoring the outer trace disclosure", () => {
    const html = renderToStaticMarkup(createElement(CodexExecutionTraceContent, {
      messages: [{
        id: "terminal-tools",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call-1", name: "shell", arguments: { command: "pwd" }, result: "/repo" },
          { id: "call-2", name: "shell", arguments: { command: "git status" }, result: "clean" },
        ],
        timestamp: 1,
      }],
      renderContent: (text: string) => text,
      runtimeProgress: [],
      nativeSubagents: {},
      enableFilePreview: false,
      onLoadResult: vi.fn(),
    }));

    expect(html.match(/class="tool-call-group"/g)).toHaveLength(1);
    expect(html).toContain("终端");
    expect(html).toContain("2 项");
    expect(html).not.toContain("codex-execution-trace__load");
    expect(html).not.toContain("执行过程 ·");
  });

  it("auto-loads only the active trace and refreshes visible rows", () => {
    expect(source).toContain("refreshSignal = 0");
    expect(source).toContain("autoLoad = false");
    expect(source).toContain("if (!autoLoad || hasMessages) return");
    expect(source).toContain("if ((!hasMessages && !autoLoad) || refreshSignal === 0) return");
    expect(source).toContain("void ensureLoaded(true)");
  });
});
