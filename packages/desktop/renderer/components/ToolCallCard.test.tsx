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

    expect(html).toContain("运行了命令");
    expect(html).not.toContain("运行命令中");
    expect(html).toContain("animation:spin 1s linear infinite");
  });

  it("omits the spinner after every command has completed", () => {
    const html = renderToStaticMarkup(createElement(ToolCallGroup, {
      items: [command("one", "done"), command("two", "")],
    }));

    expect(html).toContain("运行了命令");
    expect(html).not.toContain("animation:spin 1s linear infinite");
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
