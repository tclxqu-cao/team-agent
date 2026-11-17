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