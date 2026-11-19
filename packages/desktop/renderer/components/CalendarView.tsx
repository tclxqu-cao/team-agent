import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CalendarClock, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleDot, Inbox, ListTodo, LocateFixed, Pause, RefreshCw, Repeat, X, Zap,
} from "lucide-react";
import {
  CALENDAR_SOURCES, CALENDAR_SOURCE_LABELS, localDateKey,
  type CalendarEntry, type CalendarOverview, type CalendarSourceId,
} from "../../../core/src/domain/calendar/entities";
import { isNativeAgentType } from "../../../core/src/domain/agent/agent-type";
import "../styles/calendar.css";
import type { TodoCommand, TodoDetail } from "@agent/core";
import { AGENT_LABELS } from "../lib/agent-catalog";
import TodoScheduleEditor from "./TodoScheduleEditor";

export type CalendarLoader = (from: string, to: string) => Promise<CalendarOverview>;
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const STATE_LABEL: Record<string, string> = {
  upcoming: "待执行", paused: "已暂停", completed: "已完成", failed: "失败",
  overdue: "已过期", pending: "待处理", "in-progress": "进行中", unscheduled: "未排期",
};
const POLL_MS = 30_000;

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function timeLabel(ms: number): string {
  const d = new Date(ms);
  return `${`${d.getHours()}`.padStart(2, "0")}:${`${d.getMinutes()}`.padStart(2, "0")}`;
}
function monthLabel(year: number, month: number): string {
  return `${year}年${month + 1}月`;
}

export function personalTodoCalendarTime({ task, schedule, reminders, executions }: TodoDetail): number | undefined {
  if (task.dueAt !== undefined) return task.dueAt;
  if (schedule?.enabled && schedule.nextFireAt !== null) return schedule.nextFireAt;
  if (task.status === "completed" && schedule?.trigger.kind === "once") return schedule.trigger.at;
  // A consumed trigger still has a calendar date in the execution history.
  const executionAt = schedule && executions.find(execution =>
    execution.scheduleId === schedule.id
    && (task.status === "completed" || execution.generation === schedule.generation)
  )?.scheduledAt;
  return executionAt ?? reminders.find(reminder => reminder.enabled && reminder.nextFireAt !== null)?.nextFireAt ?? undefined;
}

/** Monday-start 6×7 grid covering the displayed month. */
function buildGrid(year: number, month: number): { key: string; day: number; inMonth: boolean; ms: number }[] {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7;
  const start = startOfDay(first.getTime()) - lead * 86_400_000;
  return Array.from({ length: 42 }, (_, index) => {
    const ms = start + index * 86_400_000;
    const d = new Date(ms);
    return { key: localDateKey(ms), day: d.getDate(), inMonth: d.getMonth() === month, ms };
  });
}

function KindIcon({ kind, size = 12 }: { kind: CalendarEntry["kind"]; size?: number }) {
  if (kind === "cron") return <Repeat size={size} aria-hidden="true" />;
  if (kind === "run") return <Zap size={size} aria-hidden="true" />;
  return <CircleDot size={size} aria-hidden="true" />;
}

function StateMark({ state }: { state: CalendarEntry["state"] }) {
  if (state === "completed") return <Check size={12} className="cal-mark is-done" role="img" aria-label="已完成" />;
  if (state === "failed") return <X size={12} className="cal-mark is-fail" aria-label="失败" />;
  if (state === "in-progress") return <span className="cal-pulse" aria-label="进行中" />;
  if (state === "paused") return <Pause size={11} className="cal-mark is-pause" aria-label="已暂停" />;
  return null;
}

function calendarEntryIdentity({ source, executionAgentType }: CalendarEntry) {
  if (!executionAgentType || executionAgentType === "customer-agent") {
    return { tone: source, label: CALENDAR_SOURCE_LABELS[source] };
  }
  if (!isNativeAgentType(executionAgentType)) {
    return { tone: source, label: executionAgentType };
  }
  const tone = executionAgentType === "claude-code" ? "claude"
    : executionAgentType === "deepseek-harness" ? "deepseek" : executionAgentType;
  return { tone, label: AGENT_LABELS[executionAgentType] };
}

function Chip({ entry, onClick, highlighted }: { entry: CalendarEntry; onClick?: () => void; highlighted?: boolean }) {
  const cls = `cal-chip kind-${entry.kind} is-${entry.state}${highlighted ? " is-highlight" : ""}`;
  const { tone, label } = calendarEntryIdentity(entry);
  const title = `${label} · ${entry.title}`;
  const body = (
    <>
      <span className="cal-chip-dot" aria-hidden="true" />
      <span className="cal-chip-time">{entry.kind === "todo" ? (entry.dueAt ? timeLabel(entry.dueAt) : "待办") : timeLabel(entry.at)}</span>
      <span className="cal-chip-title">{entry.title}</span>
      <StateMark state={entry.state} />
      {entry.state === "overdue" && <span className="cal-tag is-overdue">过期</span>}
      {entry.state === "paused" && <span className="cal-tag is-paused">暂停</span>}
    </>
  );
  return onClick
    ? <button type="button" className={cls} data-source={tone} onClick={onClick} title={title}>{body}</button>
    : <div className={cls} data-source={tone} title={title}>{body}</div>;
}

export function EntryRow({ entry, highlighted, onEditSchedule }: { entry: CalendarEntry; highlighted?: boolean; onEditSchedule?: () => void }) {
  const { tone, label } = calendarEntryIdentity(entry);
  return (
    <article className={`cal-entry is-${entry.state}${highlighted ? " is-highlight" : ""}`} data-source={tone} data-task-id={entry.taskId}>
      <div className="cal-entry-top">
        <span className="cal-entry-src">{label}</span>
        <span className={`cal-entry-state is-${entry.state}`}>{STATE_LABEL[entry.state] ?? entry.state}</span>
        <span className="cal-entry-time"><KindIcon kind={entry.kind} />{entry.kind === "todo" ? (entry.dueAt ? timeLabel(entry.dueAt) : "无截止") : timeLabel(entry.at)}</span>
      </div>
      <h4 className={`cal-entry-title ${entry.state === "completed" ? "is-struck" : ""}`}>{entry.title}</h4>
      <div className="cal-entry-meta">
        {entry.scheduleLabel && <span className="cal-meta-pill"><CalendarClock size={11} />{entry.scheduleLabel}</span>}
        {entry.recurring && <span className="cal-meta-pill"><Repeat size={11} />循环</span>}
        {entry.sessionTitle && <span className="cal-meta-pill" title={entry.sessionTitle}><ListTodo size={11} />{entry.sessionTitle}</span>}
      </div>
      {entry.executedAt !== undefined && <p className="cal-entry-detail">执行记录：{new Date(entry.executedAt).toLocaleString("zh-CN", { hour12: false })}</p>}
      {entry.kind === "cron" && entry.state === "overdue" && <p className="cal-entry-detail">计划时间已过，未找到执行结果；不代表执行成功或失败。</p>}
      {entry.detail && <p className="cal-entry-detail">{entry.detail}</p>}
      {entry.cwd && <p className="cal-entry-cwd" title={entry.cwd}>{entry.cwd}</p>}
      {onEditSchedule && <button type="button" className="cal-nav-btn cal-edit-schedule" onClick={onEditSchedule}>编辑执行计划</button>}
    </article>
  );
}

export default function CalendarView({ loadOverview, onClose, initialTaskId, focusKey = 0 }: { loadOverview: CalendarLoader; onClose?: () => void; initialTaskId?: string; focusKey?: number }) {
  const [undated, setUndated] = useState<TodoDetail[]>([]);
  const [completing, setCompleting] = useState("");
  const [highlightTaskId, setHighlightTaskId] = useState("");
  const [expandedTaskId, setExpandedTaskId] = useState("");
  const [editingSchedule, setEditingSchedule] = useState<(TodoDetail & { schedule: NonNullable<TodoDetail["schedule"]> }) | null>(null);
  const scheduleRequest = useRef(0);
  const api = typeof window === "undefined" ? undefined : window.agentApi;
  const today = new Date();
  const todayKey = localDateKey(today.getTime());
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [overview, setOverview] = useState<CalendarOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [activeSources, setActiveSources] = useState<Set<CalendarSourceId>>(() => new Set(CALENDAR_SOURCES));
  const [showUnscheduled, setShowUnscheduled] = useState(true);
  const rangeRef = useRef({ from: "", to: "" });
  const aliveRef = useRef(true);
  const focusVersionRef = useRef(0);
  // 有日历时间的待办定位到对应日期，其余在“未安排”区高亮。
  const focusTask = useCallback(async (id: string) => {
    const version = ++focusVersionRef.current;
    setActiveSources(current => new Set([...current, "customer-agent"]));
    setHighlightTaskId(id);
    try {
      const detail = api?.todoGet ? await api.todoGet(id) : undefined;
      if (version !== focusVersionRef.current) return;
      const at = detail && personalTodoCalendarTime(detail);
      if (at !== undefined) {
        const date = new Date(at);
        setCursor({ year: date.getFullYear(), month: date.getMonth() });
        setSelectedKey(localDateKey(at));
      } else setShowUnscheduled(true);
    } catch { if (version === focusVersionRef.current) setShowUnscheduled(true); }
  }, [api]);
  useEffect(() => {
    if (initialTaskId) void focusTask(initialTaskId);
    return () => { focusVersionRef.current++; };
  }, [initialTaskId, focusKey, focusTask]);

  const grid = useMemo(() => buildGrid(cursor.year, cursor.month), [cursor]);
  const from = grid[0]!.key;
  const to = grid[41]!.key;
  rangeRef.current = { from, to };

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const { from: f, to: t } = rangeRef.current;
    if (mode === "initial") setLoading(true); else setRefreshing(true);
    try {
      const api = typeof window === "undefined" ? undefined : window.agentApi;
      const [next, personal] = await Promise.all([loadOverview(f, t), api?.todoList?.({ limit: 200 }).catch(() => undefined)]);
      if (!aliveRef.current) return;
      if (personal) setUndated(personal.items.filter(detail =>
        detail.task.status !== "cancelled" && personalTodoCalendarTime(detail) === undefined
      ));
      setOverview(next);
      setError("");
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : "日历加载失败");
    } finally {
      if (aliveRef.current) { setLoading(false); setRefreshing(false); }
    }
  }, [loadOverview]);

  useEffect(() => {
    aliveRef.current = true;
    void load("initial");
    const timer = setInterval(() => { if (document.visibilityState === "visible") void load("refresh"); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void load("refresh"); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      aliveRef.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, from, to]);

  const shiftMonth = (delta: number) => {
    setCursor(current => {
      const d = new Date(current.year, current.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  };
  const goToday = () => {
    const now = new Date();
    setCursor({ year: now.getFullYear(), month: now.getMonth() });
    setSelectedKey(localDateKey(now.getTime()));
  };

  const dayEntries = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    if (!overview) return map;
    for (const [key, entries] of Object.entries(overview.days)) {
      const filtered = entries.filter(entry => entry.kind !== "todo" && activeSources.has(entry.source));
      if (filtered.length) map.set(key, filtered);
    }
    return map;
  }, [overview, activeSources]);

  const selectedEntries = dayEntries.get(selectedKey) ?? [];
  const sourceErrors = useMemo(() =>
    overview ? CALENDAR_SOURCES.filter(source => !overview.sources[source]?.ok).map(source => ({ source, error: overview.sources[source]?.error ?? "" })) : [],
    [overview]);

  const toggleSource = (source: CalendarSourceId) => {
    setActiveSources(current => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source); else next.add(source);
      return next;
    });
  };

  const selectedDate = new Date(`${selectedKey}T00:00:00`);
  const selectedLabel = `${selectedDate.getMonth() + 1} 月 ${selectedDate.getDate()} 日 · 周${WEEKDAYS[(selectedDate.getDay() + 6) % 7]}`;

  const complete = async (detail: TodoDetail) => {
    setCompleting(detail.task.id);
    try {
      const updated = await api?.todoCommand?.({ type: "complete", taskId: detail.task.id, expectedVersion: detail.task.version }, crypto.randomUUID());
      if (updated) setUndated(current => current.map(item => item.task.id === updated.task.id ? updated : item));
      await load("refresh");
    }
    catch (error) { setError(error instanceof Error ? error.message : "待办更新失败"); }
    finally { setCompleting(""); }
  };
  const editSchedule = async (id: string) => {
    const request = ++scheduleRequest.current;
    try {
      const detail = await api?.todoGet?.(id);
      if (request === scheduleRequest.current && detail?.schedule) setEditingSchedule({ ...detail, schedule: detail.schedule });
    } catch (error) {
      if (request === scheduleRequest.current) setError(error instanceof Error ? error.message : "读取执行计划失败");
    }
  };
  const closeSchedule = () => {
    scheduleRequest.current++;
    setEditingSchedule(null);
  };
  const saveSchedule = async (command: Extract<TodoCommand, { type: "schedule" }>) => {
    if (!api?.todoCommand) throw new Error("当前服务不支持编辑待办");
    const updated = await api.todoCommand(command, crypto.randomUUID());
    closeSchedule();
    const at = updated.schedule?.nextFireAt;
    if (at != null) {
      const date = new Date(at);
      setCursor({ year: date.getFullYear(), month: date.getMonth() });
      setSelectedKey(localDateKey(at));
      setHighlightTaskId(updated.task.id);
    }
    await load("refresh");
  };
  return (
    <div className="cal-root">
      <div className="cal-aurora" aria-hidden="true" />
      <header className="cal-header">
        <div className="cal-title">
          <span className="cal-title-icon"><CalendarDays size={20} aria-hidden="true" /></span>
          <div>
            <h1>智能体日历</h1>
            <p>定时任务与待办</p>
          </div>
        </div>
        <div className="cal-nav">
          {onClose && <button type="button" className="cal-nav-btn" aria-label="返回聊天" title="返回聊天" onClick={onClose}><X size={17} /></button>}
          <button type="button" className="cal-nav-btn" aria-label="上个月" onClick={() => shiftMonth(-1)}><ChevronLeft size={17} /></button>
          <button type="button" className="cal-month" onClick={goToday} title="回到今天">{monthLabel(cursor.year, cursor.month)}</button>
          <button type="button" className="cal-nav-btn" aria-label="下个月" onClick={() => shiftMonth(1)}><ChevronRight size={17} /></button>
          <button type="button" className="cal-nav-btn" aria-label="回到今天" title="回到今天" onClick={goToday}><LocateFixed size={17} /></button>
          <button type="button" className={`cal-refresh ${refreshing ? "is-spinning" : ""}`} aria-label="刷新" title="刷新" onClick={() => void load("refresh")}><RefreshCw size={17} /></button>
        </div>
      </header>

      <div className="cal-filters">
        <div className="cal-sources" role="group" aria-label="按来源筛选">
          {CALENDAR_SOURCES.map(source => (
            <button key={source} type="button" data-source={source}
              className={`cal-source-chip ${activeSources.has(source) ? "is-on" : "is-off"}`}
              onClick={() => toggleSource(source)} aria-pressed={activeSources.has(source)}>
              <span className="cal-source-dot" aria-hidden="true" />{CALENDAR_SOURCE_LABELS[source]}
              {overview && <span className="cal-source-n">{overview.sources[source]?.entries || 0}</span>}
            </button>
          ))}
        </div>
      </div>

      {sourceErrors.length > 0 && (
        <div className="cal-source-errors" role="status">
          {sourceErrors.map(({ source, error }) => (
            <span key={source} className="cal-source-error" data-source={source} title={error}><AlertTriangle size={12} />{CALENDAR_SOURCE_LABELS[source]} 读取异常</span>
          ))}
        </div>
      )}

      {error && <div className="cal-error" role="alert"><AlertTriangle size={16} />{error}<button type="button" onClick={() => void load("initial")}>重试</button></div>}

      <div className="cal-body">
        <div className="cal-grid-wrap">
          <div className="cal-weekdays">{WEEKDAYS.map(day => <span key={day} className={day === "六" || day === "日" ? "is-weekend" : ""}>周{day}</span>)}</div>
          {loading && !overview ? (
            <div className="cal-grid is-skeleton">{Array.from({ length: 42 }, (_, i) => <div key={i} className="cal-cell cal-skeleton-cell"><span className="cal-skel-bar" /><span className="cal-skel-bar is-short" /></div>)}</div>
          ) : (
            <div className="cal-grid">
              {grid.map(cell => {
                const entries = dayEntries.get(cell.key) ?? [];
                const shown = entries.slice(0, 3);
                const extra = entries.length - shown.length;
                const hasOverdue = entries.some(e => e.state === "overdue");
                const cls = `cal-cell ${cell.inMonth ? "" : "is-other"} ${cell.key === todayKey ? "is-today" : ""} ${cell.key === selectedKey ? "is-selected" : ""} ${hasOverdue ? "has-overdue" : ""}`;
                return (
                  <div key={cell.key} className={cls} role="button" tabIndex={0}
                    onClick={() => setSelectedKey(cell.key)}
                    onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedKey(cell.key); } }}>
                    <div className="cal-cell-head">
                      <span className="cal-cell-date">{cell.day}</span>
                      {cell.key === todayKey && <span className="cal-today-pill">今天</span>}
                      {entries.length > 0 && <span className="cal-cell-n">{entries.length}</span>}
                    </div>
                    <div className="cal-chips">
                      {shown.map(entry => <Chip key={entry.id} entry={entry} highlighted={entry.taskId === highlightTaskId} onClick={() => setSelectedKey(cell.key)} />)}
                      {extra > 0 && <button type="button" className="cal-more" onClick={() => setSelectedKey(cell.key)}>+{extra} 更多</button>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <aside className="cal-detail">
          <div className="cal-detail-head">
            <h2>{selectedLabel}</h2>
            <span className="cal-detail-n">{selectedEntries.length} 项</span>
          </div>
          <div className="cal-detail-list">
            {selectedEntries.length === 0 ? (
              <div className="cal-empty"><Inbox size={28} strokeWidth={1.4} /><p>这一天没有安排</p><small>点击其他日期查看安排与提醒</small></div>
            ) : selectedEntries.map(entry => <EntryRow key={entry.id} entry={entry} highlighted={entry.taskId === highlightTaskId}
              onEditSchedule={api?.todoGet && api.todoCommand && entry.taskId
                && entry.scheduleRef?.startsWith("agentroam:todo_execution_schedules:")
                ? () => void editSchedule(entry.taskId!) : undefined} />)}
          </div>
        </aside>
      </div>

      <section className={`cal-unscheduled ${showUnscheduled ? "is-open" : ""}`}>
        <button type="button" className="cal-unscheduled-head" onClick={() => setShowUnscheduled(value => !value)} aria-expanded={showUnscheduled}>
          <ListTodo size={16} />
          <span>无日期待办</span>
          <span className="cal-unscheduled-n">{undated.length} 项</span>
          <ChevronDown size={16} className="cal-unscheduled-chev" />
        </button>
        {showUnscheduled && (
          <div className="cal-unscheduled-body">
            {undated.length > 0 && <div className="cal-unsched-schedule-list">{undated.map(detail => {
              const expanded = expandedTaskId === detail.task.id;
              const completed = detail.task.status === "completed";
              const stateLabel = detail.task.status === "in_progress" ? "进行中" : detail.task.status === "failed" ? "执行失败" : "";
              return (
                <div key={detail.task.id} className={`cal-unsched-schedule ${detail.task.id === highlightTaskId ? "is-highlight" : ""}`} data-source="customer-agent">
                  <div className="cal-unsched-row">
                    {completed ? <StateMark state="completed" /> :
                      <button type="button" className="cal-nav-btn" aria-label={`完成 ${detail.task.title}`} disabled={!!completing} onClick={() => void complete(detail)}><Check size={13} /></button>}
                    <button type="button" className={`cal-unsched-title${completed ? " is-struck" : ""}`} aria-expanded={expanded} title={expanded ? "收起详情" : "查看详情"} onClick={() => setExpandedTaskId(expanded ? "" : detail.task.id)}>{detail.task.title}</button>
                  </div>
                  {stateLabel && <p>{stateLabel}</p>}
                  {expanded && (
                    <div className="cal-unsched-expand">
                      {detail.task.description && <p>{detail.task.description}</p>}
                      {detail.schedule?.enabled && <p>下次执行：{detail.schedule.nextFireAt ? new Date(detail.schedule.nextFireAt).toLocaleString("zh-CN", { hour12: false }) : "—"} · {detail.schedule.target.agentType}</p>}
                      {detail.reminders.some(reminder => reminder.enabled) && <p>已设置提醒</p>}
                      {api?.todoCommand && detail.schedule && !completed && (
                        <button type="button" className="cal-nav-btn cal-edit-schedule" onClick={() => setEditingSchedule({ ...detail, schedule: detail.schedule! })}>编辑执行计划</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}</div>}
            {undated.length === 0 && <div className="cal-empty is-inline"><Inbox size={24} strokeWidth={1.4} /><p>没有无日期待办</p></div>}
          </div>
        )}
      </section>
      {editingSchedule && <div className="cal-schedule-overlay">
        <div role="dialog" aria-modal="true" aria-labelledby="cal-schedule-title" className="cal-schedule-dialog">
          <h2 id="cal-schedule-title">{editingSchedule.task.title}</h2>
          <TodoScheduleEditor key={editingSchedule.task.id} detail={editingSchedule} onSave={saveSchedule} onClose={closeSchedule} />
        </div>
      </div>}
    </div>
  );
}
