import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ToolCallCard, { resolveToolPreviewPaths, ToolCallActivity, ToolCallGroup } from "./ToolCallCard";

const toolCallCardSource = readFileSync(new URL("./ToolCallCard.tsx", import.meta.url), "utf8");
const globalCss = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

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
  it("keeps compact child rows light until their own details are opened", () => {
    const onLoadResult = vi.fn();
    const args = { cmd: "docker exec sandbox node --version", get hiddenPayload() { throw new Error("must not serialize arguments"); } };
    const html = renderToStaticMarkup(<ToolCallActivity toolCall={{ id: "lazy", name: "exec_command", arguments: args,
      resultRef: { turnId: "turn", itemId: "lazy", revision: "rev", byteSize: 1_000_000 } }} onLoadResult={onLoadResult} />);
    expect(html).toContain("docker exec sandbox node --version");
    expect(html).not.toContain("终端");
    expect(html).not.toContain("tool-call-shell");
    expect(html).not.toContain("tool-call-activity__details");
    expect(onLoadResult).not.toHaveBeenCalled();
  });

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
  it.each([
    { name: "read_file", arguments: { file_path: "/tmp/SKILL.md" }, result: "file source", expected: "file source" },
    { name: "write_file", arguments: { file_path: "/tmp/app.ts", content: "written source" }, result: "", expected: "written source" },
    { name: "str_replace", arguments: { file_path: "/tmp/app.ts", old_string: "before", new_string: "after" }, result: "", expected: "after" },
    { name: "shell", arguments: { command: "pwd" }, result: "/tmp/workspace", expected: "/tmp/workspace" },
    { name: "Grep", arguments: { pattern: "needle" }, result: "search result", expected: "search result" },
  ])("opens $name directly under its existing activity row without another card header", ({ expected, ...tool }) => {
    const html = renderToStaticMarkup(<ToolCallActivity initiallyExpanded toolCall={{ id: "single", ...tool }} />);
    expect(html).toContain(expected);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(1);
    expect(html).not.toContain("tool-call-shell__header");
    expect(html).not.toContain("tool-call-shell__row");
    expect(html).not.toContain("tool-call-shell__disclosure");
  });

  it("keeps file preview available from the path when the duplicated header is removed", () => {
    const html = renderToStaticMarkup(<ToolCallActivity initiallyExpanded
      toolCall={{ id: "read", name: "read_file", arguments: { file_path: "/tmp/SKILL.md" }, result: "source" }}
      onOpenArtifact={vi.fn()} />);
    expect(html).toContain('aria-label="预览文件 SKILL.md"');
    expect(html).toContain("/tmp/SKILL.md");
    expect(html).not.toContain("tool-call-shell__header");
  });

  it.each([
    [{ kind: { type: "add" }, diff: "line\n".repeat(301) }, "写入", "新增 301 行，删除 0 行"],
    [{ kind: { type: "update" }, diff: "@@ -1,6 +1,6 @@\n" + "-old\n".repeat(6) + "+new\n".repeat(6) }, "编辑", "新增 6 行，删除 6 行"],
    [{ kind: { type: "delete" }, diff: "line\n".repeat(12) }, "删除", "新增 0 行，删除 12 行"],
  ])("labels patch operations and counts their lines", (change, label, statsLabel) => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "patch", name: "apply_patch", arguments: { changes: [{ path: "src/file.ts", ...change }] }, result: "done" },
    }));
    expect(html).toContain(`>${label}</span>`);
    expect(html).toContain(`aria-label="${statsLabel}"`);
  });

  it("renders all-file counts from compact lazy trace metadata without loading the result", () => {
    const onLoadResult = vi.fn();
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "patch", name: "apply_patch", arguments: { __truncated: true, changes: [], fileChangeSummary: { operation: "update", fileCount: 32, lineStats: { added: 80, removed: 6 } } },
        resultRef: { turnId: "turn", itemId: "patch", revision: "rev", byteSize: 100_000 } },
      onLoadResult,
    }));
    expect(html).toContain("32 个文件");
    expect(html).toContain('aria-label="新增 80 行，删除 6 行"');
    expect(onLoadResult).not.toHaveBeenCalled();
  });

  it("labels replacement tools as edits and counts only the changed context", () => {
    for (const name of ["Edit", "str_replace"]) {
      const html = renderToStaticMarkup(createElement(ToolCallCard, {
        toolCall: { id: "edit", name, arguments: { file_path: "a.ts", old_string: "same\nold\ntail\n", new_string: "same\nnew\ntail\n" }, result: "done" },
      }));
      expect(html).toContain(">编辑</span>");
      expect(html).toContain('aria-label="新增 1 行，删除 1 行"');
    }
  });

  it("does not invent counts from truncated writes or failed patches", () => {
    const write = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "write", name: "Write", arguments: { content: "partial", __truncated: true }, result: "done" },
    }));
    const failed = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "patch", name: "apply_patch", arguments: { changes: [{ kind: { type: "add" }, diff: "a\n" }] }, result: "failed", isError: true },
    }));
    expect(write).not.toContain("1 行");
    expect(failed).not.toContain("tool-call-line-stats");
  });
  it("keeps lazy tool results unrequested and unmounted while collapsed", () => {
    const onLoadResult = vi.fn(async () => undefined);
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: {
        id: "terminal",
        name: "shell",
        arguments: { command: "pwd" },
        resultRef: {
          turnId: "turn-1",
          itemId: "terminal",
          revision: "rev-1",
          byteSize: 100_000,
        },
      },
      onLoadResult,
    }));

    expect(onLoadResult).not.toHaveBeenCalled();
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("100,000 字节");
    expect(html).not.toContain("tool-call-shell__body");
  });

  it("loads a lazy body only on expansion and exposes loading and retry states", () => {
    expect(toolCallCardSource).toContain("if (next) void loadResult()");
    expect(toolCallCardSource).toContain("toolCall.result !== undefined || resultPendingRef.current || !onLoadResult");
    expect(toolCallCardSource).toContain("await onLoadResult(toolCall.resultRef)");
    expect(toolCallCardSource).toContain("正在加载工具结果");
    expect(toolCallCardSource).toContain("重新加载工具结果");

    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: {
        id: "terminal",
        name: "shell",
        arguments: { command: "pwd" },
        result: "complete lazy body",
      },
      nativeSubagent: {
        taskId: "task-1",
        parentToolCallId: "terminal",
        description: "Inspect",
        status: "completed",
        messages: [],
      },
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("complete lazy body");
  });

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

  it("opens files through the injected artifact callback and keeps details on a separate disclosure", () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "write", name: "write_file", arguments: { file_path: "src/app.ts", content: "source" }, result: "" },
      workspacePath: "/work/project",
      onOpenArtifact: vi.fn(),
    }));

    expect(html).toContain('class="tool-call-shell__header" aria-label="预览文件 app.ts"');
    expect(html).toContain('aria-label="预览文件 app.ts"');
    expect(html).toContain('class="tool-call-shell__disclosure"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("lucide-eye");
    expect(html).toContain("/work/project/src/app.ts");
  });

  it("lists every changed file from a multi-file patch", () => {
    expect(resolveToolPreviewPaths({
      id: "patch",
      name: "apply_patch",
      arguments: { changes: [{ path: "src/a.ts" }, { path: "/tmp/b.ts" }] },
      result: "done",
    }, "/work/project")).toEqual(["/work/project/src/a.ts", "/tmp/b.ts"]);
  });

  it("keeps file preview actions out when no artifact callback is available", () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "write", name: "write_file", arguments: { file_path: "/tmp/a.ts", content: "source" }, result: "" },
    }));

    expect(html).not.toContain('aria-label="预览文件 a.ts"');
    expect(html).not.toContain("tool-call-shell__disclosure");
    expect(html).toContain('aria-expanded="false"');
  });

  it("renders multi-file patch actions without eye icons", () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: {
        id: "patch",
        name: "apply_patch",
        arguments: { changes: [{ path: "src/a.ts" }, { path: "src/b.ts" }] },
        result: "done",
      },
      workspacePath: "/work/project",
      onOpenArtifact: vi.fn(),
    }));

    expect(html).toContain("a.ts");
    expect(html).toContain("b.ts");
    expect(html).not.toContain("lucide-eye");
  });

  it("places multi-file preview actions before verbose tool arguments", () => {
    const previewList = toolCallCardSource.indexOf('className="tool-call-file-list"');
    const argumentsBlock = toolCallCardSource.indexOf('{/* Arguments */}', previewList);

    expect(previewList).toBeGreaterThan(-1);
    expect(argumentsBlock).toBeGreaterThan(previewList);
    expect(toolCallCardSource).toContain('aria-label={`预览文件 ${basename(previewPath)}`}');
    expect(toolCallCardSource).toContain('<FileText size={12}');
  });

  it("keeps the file disclosure visually integrated with the tool row", () => {
    const disclosureRule = globalCss.match(/\.tool-call-shell__disclosure\s*\{([^}]+)\}/)?.[1] ?? "";

    expect(disclosureRule).toContain("background: transparent");
    expect(disclosureRule).not.toContain("border-left");
  });

  it("aligns file disclosure chevrons without shrinking their touch target", () => {
    const disclosureRule = globalCss.match(/\.chat-view--unified-history \.tool-call-shell__disclosure\s*\{([^}]+)\}/)?.[1] ?? "";
    const hitAreaRule = globalCss.match(/\.chat-view--unified-history \.tool-call-shell__disclosure::before\s*\{([^}]+)\}/)?.[1] ?? "";

    expect(disclosureRule).toContain("width: 11px");
    expect(disclosureRule).toContain("flex: 0 0 11px");
    expect(disclosureRule).toContain("justify-items: end");
    expect(hitAreaRule).toContain("width: 34px");
    expect(hitAreaRule).toContain("right: 0");
  });
});

describe("native subagent card", () => {
  it.each(["Agent", "Task", "Workflow"])("keeps %s running after launch and renders nested public tool output", (name) => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: {
        id: "agent-tool",
        name,
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

  it.each(["Agent", "Task", "Workflow"])("uses %s child lifecycle for terminal labels and keeps an empty running layout stable", (name) => {
    const runningHtml = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "agent-tool", name, arguments: {} },
      nativeSubagent: {
        taskId: "task-1",
        parentToolCallId: "agent-tool",
        description: "Inspect",
        status: "running",
        messages: [],
      },
    }));
    const failedHtml = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "agent-tool", name, arguments: {} },
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

  it.each(["running", "completed", "failed"] as const)("uses %s child status in a collapsed activity after the launch tool returns", (status) => {
    const html = renderToStaticMarkup(createElement(ToolCallActivity, {
      toolCall: { id: "task-tool", name: "Task", arguments: {}, result: "Task launched" },
      nativeSubagent: { taskId: "child", parentToolCallId: "task-tool", description: "Inspect", status, messages: [] },
    }));
    if (status === "running") expect(html).toContain('aria-busy="true"');
    else expect(html).not.toContain('aria-busy="true"');
    if (status === "failed") expect(html).toContain("var(--danger)");
  });

  it("preserves the native error flag on nested child tool results", () => {
    const html = renderToStaticMarkup(createElement(ToolCallCard, {
      toolCall: { id: "task-tool", name: "Task", arguments: {} },
      nativeSubagent: {
        taskId: "child", parentToolCallId: "task-tool", description: "Inspect", status: "failed",
        messages: [
          { role: "assistant", content: "", toolCalls: [{ id: "read", name: "Read", arguments: { file_path: "missing.txt" } }] },
          { role: "tool", content: "File missing", toolCallId: "read", isError: true },
        ],
      },
    }));
    expect(html).toContain("native-subagent-activity__tool-result--error");
    expect(html).toContain("File missing");
  });
});
