import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SessionExecutionTrace from "./SessionExecutionTrace";
import { ExecutionTraceContent } from "./ExecutionTrace";

function render(isRunning: boolean, durationMs?: number) {
  return renderToStaticMarkup(<SessionExecutionTrace
    group={{ id: "session-execution:user:0", isRunning, durationMs, messages: [{
      id: "progress", role: "assistant", content: "核对发送入口",
      timestamp: 1, presentation: { agentMessagePhase: "commentary" },
      toolCalls: [{ id: "call", name: "shell", arguments: { command: "rg sendTurn" }, result: "" }],
    }] }}
    renderContent={text => text} runtimeProgress={[]} nativeSubagents={{}} onLoadResult={vi.fn()}
  />);
}

describe("SessionExecutionTrace", () => {
  it("keeps a running process visible", () => {
    const html = render(true);
    expect(html).toContain('data-message-id="session-execution:user:0"');
    expect(html).toContain("核对发送入口");
    expect(html).toContain("运行了命令");
    expect(html).not.toContain("rg sendTurn");
    expect(html).not.toContain("execution-trace__summary");
  });

  it("unmounts a completed process and shows an accessible disclosure with timing", () => {
    const html = render(false, 65_000);
    expect(html).toContain("已工作 1 分 5 秒");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("aria-controls=");
    expect(html).not.toContain("execution-trace__timeline");
    expect(html).not.toContain("核对发送入口");
  });

  it("keeps old history collapsible when native completion timing is unavailable", () => {
    expect(render(false)).toContain("已工作");
    expect(render(false)).not.toContain("秒");
  });

  it("keeps prose visible and groups mixed tool vocabularies in one lazy activity row", () => {
    const html = renderToStaticMarkup(<ExecutionTraceContent
      messages={[{
        id: "mixed", role: "assistant", content: "配置已经核对完成。", timestamp: 1,
        presentation: {
          agentMessagePhase: "commentary",
          reasoning: [{ sectionIndex: 0, text: "先核对配置与调用入口。" }],
        },
        toolCalls: [
          { id: "read-1", name: "Read", arguments: { file_path: "/private/config.ts" }, result: "large hidden result" },
          { id: "read-2", name: "read", arguments: { filePath: "/private/config.ts" }, result: "" },
          { id: "edit", name: "edit", arguments: {}, result: "" },
          { id: "command", name: "exec_command", arguments: { cmd: "secret command arguments" }, result: "" },
        ],
      }]}
      renderContent={text => text} runtimeProgress={[]} nativeSubagents={{}} onLoadResult={vi.fn()}
    />);
    expect(html).toContain("先核对配置与调用入口。");
    expect(html).toContain("配置已经核对完成。");
    expect(html).toContain('data-presentation="activity"');
    expect(html.match(/class="tool-call-group__label">([^<]+)/)?.[1]).toBe("读取了文件、修改了文件、运行了命令");
    expect(html.match(/class="tool-call-group"/g)).toHaveLength(1);
    expect(html).not.toContain("reasoning-summary__toggle");
    expect(html).not.toContain("tool-call-group__items");
    expect(html).not.toContain("tool-call-group__count");
    expect(html).not.toContain("private/config");
    expect(html).not.toContain("large hidden result");
    expect(html).not.toContain("secret command arguments");
    expect(html).not.toContain("aria-busy");
  });

  it("supports single unknown tools and preserves pending and failure states", () => {
    const renderTool = (toolCall: { id: string; name: string; arguments: {}; result?: string; isError?: boolean }) => renderToStaticMarkup(<ExecutionTraceContent
      messages={[{ id: "custom", role: "assistant", content: "", timestamp: 1, toolCalls: [toolCall] }]}
      renderContent={text => text} runtimeProgress={[]} nativeSubagents={{}} onLoadResult={vi.fn()}
    />);
    const pending = renderTool({ id: "one", name: "constructor", arguments: {} });
    expect(pending).toContain("调用了工具");
    expect(pending).toContain('aria-busy="true"');
    const failed = renderTool({ id: "one", name: "new_custom_tool", arguments: {}, result: "", isError: true });
    expect(failed).toContain("1 项失败");
    expect(failed).not.toContain("aria-busy");
  });
});
