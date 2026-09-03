import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ToolCallCard, { ToolCallGroup } from "./ToolCallCard";

function command(id: string, result?: string) {
  return {
    toolCall: {
      id,
      name: "shell",
      arguments: { command: `echo ${id}` },
      ...(result === undefined ? {} : { result }),
    },
  };
}

describe("ToolCallGroup", () => {
  it("keeps the completed action label and adds a spinner while a command is running", () => {
    const html = renderToStaticMarkup(createElement(ToolCallGroup, {
      items: [command("one", "done"), command("two")],
    }));

    expect(html).toContain("终端");
    expect(html).not.toContain("运行命令中");
    expect(html).toContain("lucide-square-terminal");
    expect(html).toContain("animation:spin 1s linear infinite");
  });

  it("omits the spinner after every command has completed", () => {
    const html = renderToStaticMarkup(createElement(ToolCallGroup, {
      items: [command("one", "done"), command("two", "")],
    }));

    expect(html).toContain("终端");
    expect(html).not.toContain("animation:spin 1s linear infinite");
  });
});

describe("tool activity rows", () => {
  it("uses distinct icons for terminal, read, write, and search operations", () => {
    const terminal = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "terminal", name: "shell", arguments: { command: "pwd" }, result: "" },
    }));
    const read = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "read", name: "read_file", arguments: { file_path: "/tmp/a.ts" }, result: "source" },
    }));
    const write = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "write", name: "write_file", arguments: { file_path: "/tmp/a.ts", content: "source" }, result: "" },
    }));
    const search = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "search", name: "Grep", arguments: { pattern: "needle" }, result: "match" },
    }));

    expect(terminal).toContain("lucide-square-terminal");
    expect(terminal).toContain("终端");
    expect(read).toContain("lucide-file-text");
    expect(read).toContain("查阅");
    expect(write).toContain("lucide-pencil");
    expect(write).toContain("写入");
    expect(search).toContain("lucide-search");
    expect(search).toContain("查阅");
  });

  it("keeps single activity rows expandable", () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "terminal", name: "shell", arguments: { command: "pwd" }, result: "/tmp" },
    }));

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("tool-call-shell__chevron");
  });
});

describe("native Claude Agent card", () => {
  it("stays running after launch and renders nested public tool output", () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: {
        id: "agent-tool",
        name: "Agent",
        arguments: { prompt: "Inspect files", run_in_background: true },
        result: "Agent launched successfully",
      },
      nativeSubagent: {
        taskId: "task-1",
        parentToolCallId: "agent-tool",
        agentName: "Explore",
        description: "Inspect files",
        status: "running",
        elapsedSeconds: 3,
        toolUses: 1,
        messages: [
          {
            role: "assistant",
            content: "Reading the adapter",
            toolCalls: [{ id: "read-1", name: "Read", arguments: { file_path: "adapter.ts" } }],
          },
          { role: "tool", content: "source text", toolCallId: "read-1" },
        ],
      },
      onSelectSession: () => undefined,
    }));

    expect(html).toContain("@Explore");
    expect(html).toContain("运行中");
    expect(html).toContain("Reading the adapter");
    expect(html).toContain("source text");
    expect(html).not.toContain("Agent launched successfully");
    expect(html).not.toContain("查看子会话");
  });

  it("uses the child lifecycle for terminal labels and keeps an empty running layout stable", () => {
    const runningHtml = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "agent-tool", name: "Agent", arguments: {} },
      nativeSubagent: {
        taskId: "task-1",
        parentToolCallId: "agent-tool",
        description: "Inspect",
        status: "running",
        messages: [],
      },
    }));
    const failedHtml = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "agent-tool", name: "Agent", arguments: {} },
      nativeSubagent: {
        taskId: "task-1",
        parentToolCallId: "agent-tool",
        description: "Inspect",
        status: "failed",
        summary: "Unable to inspect",
        messages: [],
      },
    }));

    expect(runningHtml).toContain("子 agent 正在工作");
    expect(failedHtml).toContain("错误");
    expect(failedHtml).toContain("Unable to inspect");
  });
});
