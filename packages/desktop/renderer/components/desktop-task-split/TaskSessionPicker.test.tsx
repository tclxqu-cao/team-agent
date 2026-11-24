import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogSession } from "../../../../core/src/domain/supervision/types";
import { ALL_SESSIONS_CACHE_KEY } from "../../lib/all-sessions-cache";
import TaskSessionPicker, { groupTaskSessions } from "./TaskSessionPicker";
import { buildSessionTree } from "../../lib/session-tree";

vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));

const session = (id: string, title = id, agentType: CatalogSession["agentType"] = "codex", cwd = "/project"): CatalogSession => ({
  id, title, agentType, cwd, updated: "2026-11-17", status: "idle", canResume: true,
});

function renderPicker(cached: CatalogSession[], knownSessions: CatalogSession[] = []) {
  const request = vi.fn();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key === ALL_SESSIONS_CACHE_KEY
    ? JSON.stringify({ version: 2, data: cached, total: cached.length, nextCursor: "expired" }) : null },
  agentApi: { collaboration: request } });
  vi.stubGlobal("document", { body: {} });
  const html = renderToStaticMarkup(createElement(TaskSessionPicker, {
    currentId: "current", openIds: new Set(["open"]), knownSessions, onChoose: () => {}, onClose: () => {},
  }));
  return { html, request };
}

afterEach(() => vi.unstubAllGlobals());

describe("task picker synchronous cache display", () => {
  it("renders selectable all-sessions cache before any remote discovery starts", () => {
    const { html, request } = renderPicker([session("cached", "无需等待扫描的任务")]);
    expect(html).toContain("无需等待扫描的任务");
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain("显示已有任务，正在后台更新");
    expect(html).not.toContain("加载更多任务");
    expect(html).not.toContain("expired");
    expect(request).not.toHaveBeenCalled();
  });

  it("uses current pane summaries when the persistent cache is empty", () => {
    const { html } = renderPicker([], [session("current", "当前会话"), session("open", "另一分屏任务")]);
    expect(html).toContain("当前会话");
    expect(html).toContain("当前任务");
    expect(html).toContain("另一分屏任务");
    expect(html).toContain("已在分屏");
    expect(html).toMatch(/disabled=""[^>]*>.*?当前会话/s);
  });

  it("prefers the current pane summary over a stale cached duplicate", () => {
    const { html } = renderPicker([session("open", "旧标题")], [session("open", "新标题")]);
    expect(html).toContain("新标题");
    expect(html).not.toContain("旧标题");
    expect(html.match(/class="task-picker-item"/g)).toHaveLength(1);
  });

  it("shows unread completions for finished native sessions in the task picker", () => {
    const completedAt = "2026-11-17T10:00:00Z";
    const { html } = renderPicker([
      { ...session("unread"), completedAt },
      { ...session("current"), completedAt },
      { ...session("busy"), completedAt, status: "running" },
      session("idle"),
    ]);
    expect(html.match(/is-unread-completion/g)).toHaveLength(1);
    expect(html).toContain('aria-label="已完成，未查看"');
    expect(html).toMatch(/is-unread-completion[^>]*>.*?<strong>unread<\/strong>/s);
    expect(html).toContain("sidebar-status-dot is-running");
  });

  it("groups tasks by Agent and then folder while preserving catalog order", () => {
    const groups = groupTaskSessions(buildSessionTree([
      session("codex-one", "Codex one", "codex", "/repo/one"),
      session("codex-two", "Codex two", "codex", "/repo/one"),
      session("codex-three", "Codex three", "codex", "/repo/two"),
      session("claude-one", "Claude one", "claude-code", "/repo/one"),
    ]));
    expect(groups.map(group => [group.label, group.sessionCount, group.folders.map(folder => [folder.label, folder.sessions.length])])).toEqual([
      ["Codex", 3, [["/repo/one", 2], ["/repo/two", 1]]],
      ["Claude Code", 1, [["/repo/one", 1]]],
    ]);

    const { html } = renderPicker([
      session("codex-one", "Codex one", "codex", "/repo/one"),
      session("codex-two", "Codex two", "codex", "/repo/one"),
      session("codex-three", "Codex three", "codex", "/repo/two"),
      session("claude-one", "Claude one", "claude-code", "/repo/one"),
    ]);
    expect(html.match(/class="task-picker-group-header"/g)).toHaveLength(2);
    expect(html.match(/class="task-picker-folder-header"/g)).toHaveLength(3);
    expect(html).toContain('aria-label="任务排列方式"');
    expect(html).toContain(">列表</button>");
    expect(html).toContain("3 个任务");
    expect(html).toContain("/repo/two");
  });

  it("hides children from another working directory behind the parent disclosure", () => {
    const { html } = renderPicker([
      { ...session("child", "子任务", "codex", "/repo/worker"), parentSessionId: "parent" },
      session("parent", "主任务", "codex", "/repo/main"),
    ]);
    expect(html.match(/class="task-picker-folder-header"/g)).toHaveLength(1);
    expect(html).toMatch(/>主任务<.*?<\/button><button[^>]*aria-label="展开子会话：主任务"[^>]*aria-expanded="false"/s);
    expect(html).not.toContain(">子任务<");
    expect(html).not.toContain("/repo/worker");
  });
});
