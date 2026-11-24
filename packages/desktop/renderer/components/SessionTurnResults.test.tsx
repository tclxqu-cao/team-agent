import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import SessionTurnResults from "./SessionTurnResults";
import MessageArtifactLink from "./MessageArtifactLink";

describe("turn artifact actions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["report.pdf", "report.docx"])("shows file manager and application selection for %s", file => {
    vi.stubGlobal("window", { agentApi: { artifactFileAction: vi.fn() } });
    const html = renderToStaticMarkup(createElement(SessionTurnResults, {
      turn: {
        footerId: "message",
        messages: [{ id: "message", role: "assistant", content: `[交付报告](/work/outputs/${file})` }],
        traces: [],
      },
      loadTrace: vi.fn(),
      onLoadResult: vi.fn(),
      onOpenArtifact: vi.fn(),
    }));
    expect(html).toContain('aria-label="交付物操作 交付报告"');
    expect(html).toContain('aria-label="在文件管理器中显示"');
    expect(html).toContain('aria-label="打开方式…"');
    expect(html.match(/class="artifact-file-actions"/g)).toHaveLength(1);
    const inline = renderToStaticMarkup(createElement(MessageArtifactLink, {
      path: `/work/outputs/${file}`, label: "交付报告", onOpen: vi.fn(), children: "交付报告",
    }));
    expect(inline).toContain('aria-label="打开交付物 交付报告"');
    expect(inline).not.toContain('class="artifact-file-actions"');
  });

  it("shows both actions on a changed-file row before its details are expanded", () => {
    vi.stubGlobal("window", { agentApi: { artifactFileAction: vi.fn() } });
    const html = renderToStaticMarkup(createElement(SessionTurnResults, {
      turn: {
        footerId: "message",
        messages: [{
          id: "message", role: "assistant", content: "已生成图表",
          toolCalls: [{ id: "write", name: "write_file", arguments: { file_path: "/work/collection.html" }, result: "ok" }],
        }],
        traces: [],
      },
      loadTrace: vi.fn(),
      onLoadResult: vi.fn(),
      onOpenArtifact: vi.fn(),
    }));
    expect(html).toContain('aria-label="查看改动 collection.html"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-label="在文件管理器中显示"');
    expect(html).toContain('aria-label="打开方式…"');
  });
});
