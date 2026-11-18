import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CatalogSession } from "../../../../core/src/domain/supervision/types";
import { ALL_SESSIONS_CACHE_KEY } from "../../lib/all-sessions-cache";
import TaskSessionPicker from "./TaskSessionPicker";

vi.mock("react-dom", () => ({ createPortal: (children: unknown) => children }));

const session = (id: string, title = id): CatalogSession => ({
  id, title, agentType: "codex", cwd: "/project", updated: "2026-11-17", status: "idle", canResume: true,
});

function renderPicker(cached: CatalogSession[], knownSessions: CatalogSession[] = []) {
  const request = vi.fn();
  vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key === ALL_SESSIONS_CACHE_KEY
    ? JSON.stringify({ version: 1, data: cached, total: cached.length, nextCursor: "expired" }) : null },
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
});
