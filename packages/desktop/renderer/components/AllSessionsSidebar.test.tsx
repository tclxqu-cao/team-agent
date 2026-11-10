import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALL_SESSIONS_CACHE_KEY } from "../lib/all-sessions-cache";

vi.mock("../lib/page-activity", () => ({ usePageActive: () => true, isPageActive: () => true }));
import AllSessionsSidebar from "./AllSessionsSidebar";

afterEach(() => vi.unstubAllGlobals());

describe("all sessions cache presentation", () => {
  it("renders cached summaries and total synchronously before any request completes", () => {
    vi.stubGlobal("window", { localStorage: { getItem: (key: string) => key === ALL_SESSIONS_CACHE_KEY ? JSON.stringify({
      version: 1, total: 2620,
      data: [{ id: "cached", agentType: "codex", title: "缓存中的任务", cwd: "/project", updated: "2026-11-09", status: "idle", canResume: true }],
    }) : null } });
    const html = renderToStaticMarkup(createElement(AllSessionsSidebar, {
      selectedSessionId: null, runningSessionId: null, needsInput: [], pinnedIds: [], revision: 0,
      onSelect: () => {}, onPin: () => {}, onDelete: () => {},
    }));
    expect(html).toContain("缓存中的任务");
    expect(html).toContain(">2620<");
    expect(html).toContain("当前显示缓存");
    expect(html).not.toContain("正在加载所有会话…");
    expect(html).not.toContain("加载更早的会话");
  });
});
