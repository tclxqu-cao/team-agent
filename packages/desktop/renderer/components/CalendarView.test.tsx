import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CalendarView from "./CalendarView";
import type { CalendarOverview } from "../../../core/src/domain/calendar/entities";

const empty: CalendarOverview = {
  from: "2026-11-01", to: "2026-12-06", generatedAt: 0,
  days: {}, unscheduled: [], unscheduledSchedules: [],
  sources: {
    "customer-agent": { ok: true, entries: 0, todos: 0 }, codex: { ok: true, entries: 0, todos: 0 },
    claude: { ok: true, entries: 0, todos: 0 }, workbuddy: { ok: true, entries: 0, todos: 0 },
    zcode: { ok: true, entries: 0, todos: 0 }, opencode: { ok: true, entries: 0, todos: 0 },
    deepseek: { ok: true, entries: 0, todos: 0 },
  },
};

describe("CalendarView", () => {
  it("provides a return-to-chat action only when hosted as a desktop pane", () => {
    const html = renderToStaticMarkup(createElement(CalendarView, { loadOverview: async () => empty, onClose: () => {} }));
    expect(html).toContain('aria-label="返回聊天"');
    const standalone = renderToStaticMarkup(createElement(CalendarView, { loadOverview: async () => empty }));
    expect(standalone).not.toContain('aria-label="返回聊天"');
  });
  it("keeps todos and scheduled tasks inside the calendar without notification controls", () => {
    const html = renderToStaticMarkup(createElement(CalendarView, { loadOverview: async () => empty }));
    expect(html).toContain("无日期待办");
    expect(html).toContain("定时任务");
    expect(html).toContain("未排期任务");
    expect(html).not.toContain("通知");
    expect(html).not.toContain("todo-notifications");
    expect(html).not.toContain("创建 / 管理待办");
    expect(html).not.toContain("管理待办");
    expect(html).not.toContain("我的待办");
  });
  it("renders the header, every source filter and the loading grid without crashing", () => {
    const html = renderToStaticMarkup(createElement(CalendarView, { loadOverview: async () => empty }));
    expect(html).toContain("智能体日历");
    expect(html).toContain("AgentRoam");
    expect(html).toContain("Claude Code");
    expect(html).toContain("DeepSeek");
    expect(html).toContain("cal-grid is-skeleton");
    expect(html).toContain("未安排");
    // All seven sources expose a toggle.
    expect(html.match(/cal-source-chip/g)?.length).toBe(7);
  });
});
