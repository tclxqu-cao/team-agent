import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import CalendarView, { EntryRow, personalTodoCalendarTime } from "./CalendarView";
import type { CalendarOverview } from "../../../core/src/domain/calendar/entities";
import type { TodoDetail, TodoExecutionSchedule } from "@agent/core";

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
  it("labels and colors scheduled Todos by the assigned Agent, with the source as fallback", () => {
    const entry = { id: "schedule", kind: "cron", state: "upcoming", source: "customer-agent", at: 0, title: "调研" } as const;
    const render = (executionAgentType?: string) => renderToStaticMarkup(createElement(EntryRow, {
      entry: { ...entry, executionAgentType },
    }));
    expect(render("codex")).toContain('class="cal-entry-src">Codex</span>');
    expect(render("zcode")).toContain('class="cal-entry-src">ZCode</span>');
    expect(render("zcode")).toContain('data-source="zcode"');
    expect(render("claude-code")).toContain('data-source="claude"');
    expect(render()).toContain('class="cal-entry-src">AgentRoam</span>');
  });

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
    expect(html).not.toContain("cal-stats");
    expect(html).not.toContain('aria-label="按类型筛选"');
    expect(html).not.toContain("未排期任务");
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
    expect(html).toContain("无日期待办");
    // All seven sources expose a toggle.
    expect(html.match(/cal-source-chip/g)?.length).toBe(7);
  });
});

describe("personal todo calendar time", () => {
  const scheduledAt = Date.parse("2026-11-18T23:00:00+08:00");
  const undated: TodoDetail = {
    task: {
      id: "task", ownerId: "owner", title: "调研", description: "", kind: "normal", status: "pending",
      version: 1, controlRevision: 0, createdAt: 0, updatedAt: 0,
    },
    reminders: [], links: [], executions: [],
  };
  const schedule: TodoExecutionSchedule = {
    id: "schedule", ownerId: "owner", taskId: "task", enabled: true, nextFireAt: scheduledAt, generation: 1,
    timeZone: "Asia/Shanghai", trigger: { kind: "once", at: scheduledAt },
    target: { agentType: "zcode", cwd: "/workspace", permissionMode: "default" },
  };
  const scheduled: TodoDetail = { ...undated, task: { ...undated.task, kind: "scheduled" }, schedule };

  it("places an executable todo on the scheduled date even without a due date", () => {
    expect(personalTodoCalendarTime(scheduled)).toBe(scheduledAt);
    expect(personalTodoCalendarTime(undated)).toBeUndefined();
    const dueAt = scheduledAt + 3600000;
    expect(personalTodoCalendarTime({ ...scheduled, task: { ...scheduled.task, dueAt } })).toBe(dueAt);
  });

  it("keeps a fired one-time todo on its execution date and ignores obsolete plans", () => {
    const fired: TodoDetail = {
      ...scheduled,
      schedule: { ...schedule, enabled: false, nextFireAt: null },
      executions: [{
        id: "execution", ownerId: "owner", taskId: "task", scheduleId: schedule.id,
        generation: 1, scheduledAt, controlRevision: 0, status: "running", target: schedule.target,
      }],
    };
    expect(personalTodoCalendarTime(fired)).toBe(scheduledAt);
    expect(personalTodoCalendarTime({ ...fired, executions: [] })).toBeUndefined();
    expect(personalTodoCalendarTime({ ...fired, schedule: { ...schedule, enabled: false, nextFireAt: null, generation: 2 } })).toBeUndefined();
  });

  it("keeps the intended date when a scheduled todo is completed before it fires", () => {
    const completed: TodoDetail = {
      ...scheduled,
      task: { ...scheduled.task, status: "completed" },
      schedule: { ...schedule, enabled: false, nextFireAt: null, generation: 2 },
    };
    expect(personalTodoCalendarTime(completed)).toBe(scheduledAt);
    expect(personalTodoCalendarTime({ ...undated, task: { ...undated.task, status: "completed" } })).toBeUndefined();
  });
});
