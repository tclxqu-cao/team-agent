import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import CodexExecutionTrace from "./CodexExecutionTrace";
import { ExecutionTraceContent } from "./ExecutionTrace";

const source = readFileSync(new URL("./CodexExecutionTrace.tsx", import.meta.url), "utf8");

describe("CodexExecutionTrace", () => {
  it.each([
    { revision: "live:turn-1", liveMessages: [] },
    { revision: "live:turn-1", liveMessages: [{
      id: "thinking", role: "assistant" as const, content: "", timestamp: 1,
      presentation: { reasoning: [{ itemId: "r", sectionIndex: 0, text: "根据用户回复继续" }] },
    }] },
    { revision: "rev-1", historyItemKeys: [] },
    { revision: "rev-1", historyItemKeys: ["reasoning:r:0"] },
  ])("omits a completed trace with no visible activity: %j", (trace) => {
    const loadTrace = vi.fn(async () => []);
    const html = renderToStaticMarkup(<CodexExecutionTrace
      trace={{ turnId: "turn-1", ...trace }} loadTrace={loadTrace} loadToolResult={vi.fn()}
      renderContent={text => text} runtimeProgress={[]} nativeSubagents={{}}
    />);
    expect(html).toBe("");
    expect(loadTrace).not.toHaveBeenCalled();
  });

  it.each(["tool:call-1", "agent:commentary-1"])("preserves unloaded history with visible activity: %s", (key) => {
    const loadTrace = vi.fn(async () => []);
    const html = renderToStaticMarkup(<CodexExecutionTrace
      trace={{ turnId: "turn-1", revision: "rev-1", historyItemKeys: ["reasoning:r:0", key] }}
      loadTrace={loadTrace} loadToolResult={vi.fn()}
      renderContent={text => text} runtimeProgress={[]} nativeSubagents={{}}
    />);
    expect(html).toContain("已工作");
    expect(loadTrace).not.toHaveBeenCalled();
  });

  it.each(["started", "interacted", "completed"])("preserves a completed trace containing only %s child task activity", (kind) => {
    const html = renderToStaticMarkup(<CodexExecutionTrace
      trace={{ turnId: "turn-1", revision: "rev-1", historyItemKeys: [], liveMessages: [{
        id: "child-activity", role: "assistant", content: "", timestamp: 1, toolCalls: [{
          id: "child-activity", name: "codex:subagentActivity",
          arguments: { kind, agentThreadId: "child-thread", agentPath: "/root/question_card_ui" }, result: "",
        }],
      }] }}
      loadTrace={vi.fn(async () => [])} loadToolResult={vi.fn()}
      renderContent={text => text} runtimeProgress={[]} nativeSubagents={{}}
    />);
    expect(html).toContain("已工作");
  });

  it("collapses completed history without requesting trace data", () => {
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
    expect(html).toContain("已工作");
    expect(html).toContain("execution-trace__summary");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("execution-trace__timeline");
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
      isRunning: true,
    }));

    expect(loadTrace).not.toHaveBeenCalled();
    expect(html).toContain('class="execution-activity-block"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("正在处理这条消息");
    expect(html).not.toContain("查看执行过程");
    expect(html).toContain("execution-trace__summary");
    expect(html).toContain("已工作 0 秒");
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
      isRunning: true,
    }));

    expect(loadTrace).not.toHaveBeenCalled();
    expect(html).toContain("execution-trace__timeline");
    expect(html).toContain("运行了命令");
    expect(html).not.toContain("pwd");
    expect(html).not.toContain("查看执行过程");
  });

  it("renders commentary text inside the execution timeline", () => {
    const html = renderToStaticMarkup(createElement(ExecutionTraceContent, {
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
      onLoadResult: vi.fn(),
    }));

    expect(html).toContain("execution-trace__commentary");
    expect(html).toContain("正在检查项目文件");
  });

  it("groups adjacent terminal calls without restoring the outer trace disclosure", () => {
    const html = renderToStaticMarkup(createElement(ExecutionTraceContent, {
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
      onLoadResult: vi.fn(),
    }));

    expect(html.match(/class="execution-activity-block"/g)).toHaveLength(1);
    expect(html).toContain("运行了命令");
    expect(html).toContain("2 项");
    expect(html).not.toContain("execution-trace__load");
    expect(html).not.toContain("执行过程 ·");
  });

  it("auto-loads only the active trace and refreshes visible rows", () => {
    expect(source).toContain("refreshSignal = 0");
    expect(source).toContain("autoLoad = false");
    expect(source).toContain("if (!needsHistory) return");
    expect(source).toContain("if (!expanded || error || (!hasMessages && !autoLoad) || refreshSignal === 0) return");
    expect(source).toContain("void ensureLoaded(true)");
  });

  it("keeps history loading visible alongside already recovered live commentary", () => {
    const html = renderToStaticMarkup(createElement(CodexExecutionTrace, {
      trace: { turnId: "turn-1", revision: "persisted-revision", liveMessages: [{
        id: "commentary", role: "assistant", content: "Checking files",
        presentation: { agentMessagePhase: "commentary" }, timestamp: 1,
      }] },
      loadTrace: vi.fn(async () => []), loadToolResult: vi.fn(),
      renderContent: (text: string) => text, runtimeProgress: [], nativeSubagents: {}, autoLoad: true,
      isRunning: true,
    }));
    expect(html).toContain("正在加载执行过程");
    expect(html).toContain("Checking files");
    expect(html).toContain('aria-busy="true"');
  });

  it("keeps recovered completed progress collapsed even for the latest auto-loaded turn", () => {
    const loadTrace = vi.fn(async () => []);
    const html = renderToStaticMarkup(<CodexExecutionTrace
      trace={{ turnId: "done", revision: "rev", liveMessages: [{
        id: "progress", role: "assistant", content: "Checking files",
        presentation: { agentMessagePhase: "commentary" }, timestamp: 1,
      }] }}
      loadTrace={loadTrace} loadToolResult={vi.fn()} renderContent={text => text}
      runtimeProgress={[]} nativeSubagents={{}} autoLoad durationMs={565_000}
    />);
    expect(html).toContain("已工作 9 分 25 秒");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("Checking files");
    expect(html).not.toContain("execution-trace__timeline");
    expect(loadTrace).not.toHaveBeenCalled();
  });

  it("removes invisible rows and boundary newlines while preserving empty tool results", () => {
    const renderContent = vi.fn((text: string) => text);
    const html = renderToStaticMarkup(<ExecutionTraceContent
      messages={[
        { id: "empty", role: "assistant", content: "", timestamp: 1 },
        { id: "spaces", role: "assistant", content: "\n  ", timestamp: 2,
          presentation: { agentMessagePhase: "commentary", reasoning: [{ sectionIndex: 0, text: " " }] } },
        { id: "tool", role: "assistant", content: "", timestamp: 3,
          toolCalls: [{ id: "call", name: "shell", arguments: { command: "pwd" }, result: "" }] },
        { id: "text", role: "assistant", content: "\n\n检查完成\n\n", timestamp: 4,
          presentation: { agentMessagePhase: "commentary" } },
      ]}
      renderContent={renderContent} runtimeProgress={[]} nativeSubagents={{}} onLoadResult={vi.fn()}
    />);
    expect(html.match(/class="execution-trace__item"/g)).toHaveLength(2);
    expect(html).toContain("运行了命令");
    expect(html).not.toContain("pwd");
    expect(html).not.toContain('aria-busy="true"');
    expect(renderContent).toHaveBeenCalledWith("检查完成");
  });
});

describe("Codex resumed execution display", () => {
  const live = {
    id: "codex-trace:turn-1:agent:progress", role: "assistant" as const,
    content: "Original request progress", timestamp: 1,
    presentation: { agentMessagePhase: "commentary" as const },
  };
  const render = (segmentIndex: number, revision: string, historyItemKeys?: string[]) => renderToStaticMarkup(
    <CodexExecutionTrace trace={{ turnId: "turn-1", revision, segmentIndex, historyItemKeys, liveMessages: [live] }}
      loadTrace={vi.fn().mockResolvedValue([])} loadToolResult={vi.fn()} renderContent={text => text}
      runtimeProgress={[]} nativeSubagents={{}} autoLoad isRunning />,
  );

  it("waits for native ownership before displaying a run replay beneath a follow-up", () => {
    const html = render(1, "rev");
    expect(html).toContain("正在处理这条消息");
    expect(html).not.toContain(live.content);
    expect(render(1, "rev", ["agent:" + live.id])).toContain(live.content);
  });

  it("shows an initial segment and a fresh live turn immediately", () => {
    expect(render(0, "rev")).toContain(live.content);
    expect(render(1, "live:turn-1")).toContain(live.content);
  });
});
