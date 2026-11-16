import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import SessionExecutionTrace from "./SessionExecutionTrace";

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
    expect(html).toContain("rg sendTurn");
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
    expect(render(false)).toContain("执行过程");
    expect(render(false)).not.toContain("已工作");
  });
});
