import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, CalendarClock, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleDot, Inbox, ListTodo, Pause, RefreshCw, Repeat, Timer, X, Zap,
} from "lucide-react";
import {
  CALENDAR_SOURCES, CALENDAR_SOURCE_LABELS, localDateKey,
  type CalendarEntry, type CalendarOverview, type CalendarSourceId, type CalendarTodoGroup,
} from "../../../core/src/domain/calendar/entities";
import "../styles/calendar.css";

export type CalendarLoader = (from: string, to: string) => Promise<CalendarOverview>;
type KindFilter = "all" | "cron" | "run" | "todo";

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const KIND_LABEL: Record<KindFilter, string> = { all: "全部", cron: "定时", run: "执行", todo: "待办" };
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
  return `${year} 年 ${month + 1} 月`;
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
  if (state === "completed") return <Check size={12} className="cal-mark is-done" aria-label="已完成" />;
  if (state === "failed") return <X size={12} className="cal-mark is-fail" aria-label="失败" />;
  if (state === "in-progress") return <span className="cal-pulse" aria-label="进行中" />;
  if (state === "paused") return <Pause size={11} className="cal-mark is-pause" aria-label="已暂停" />;
  return null;
}

function Chip({ entry, onClick }: { entry: CalendarEntry; onClick?: () => void }) {
  const cls = `cal-chip kind-${entry.kind} is-${entry.state}`;
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
    ? <button type="button" className={cls} data-source={entry.source} onClick={onClick} title={`${CALENDAR_SOURCE_LABELS[entry.source]} · ${entry.title}`}>{body}</button>
    : <div className={cls} data-source={entry.source} title={`${CALENDAR_SOURCE_LABELS[entry.source]} · ${entry.title}`}>{body}</div>;
}

function EntryRow({ entry }: { entry: CalendarEntry }) {
  return (
    <article className={`cal-entry is-${entry.state}`} data-source={entry.source}>
      <div className="cal-entry-top">
        <span className="cal-entry-src" data-source={entry.source}>{CALENDAR_SOURCE_LABELS[entry.source]}</span>
        <span className={`cal-entry-state is-${entry.state}`}>{STATE_LABEL[entry.state] ?? entry.state}</span>
        <span className="cal-entry-time"><KindIcon kind={entry.kind} />{entry.kind === "todo" ? (entry.dueAt ? timeLabel(entry.dueAt) : "无截止") : timeLabel(entry.at)}</span>
      </div>
      <h4 className={`cal-entry-title ${entry.state === "completed" ? "is-struck" : ""}`}>{entry.title}</h4>
      <div className="cal-entry-meta">
        {entry.scheduleLabel && <span className="cal-meta-pill"><CalendarClock size={11} />{entry.scheduleLabel}</span>}
        {entry.recurring && <span className="cal-meta-pill"><Repeat size={11} />循环</span>}
        {entry.sessionTitle && <span className="cal-meta-pill" title={entry.sessionTitle}><ListTodo size={11} />{entry.sessionTitle}</span>}
      </div>
      {entry.detail && <p className="cal-entry-detail">{entry.detail}</p>}
      {entry.cwd && <p className="cal-entry-cwd" title={entry.cwd}>{entry.cwd}</p>}
    </article>
  );
}

function TodoRow({ entry }: { entry: CalendarEntry }) {
  return (
    <li className={`cal-todo is-${entry.state}`} data-source={entry.source}>
      <span className="cal-todo-box" aria-hidden="true">{entry.state === "completed" ? <Check size={12} /> : entry.state === "in-progress" ? <span className="cal-pulse" /> : null}</span>
      <span className={`cal-todo-text ${entry.state === "completed" ? "is-struck" : ""}`}>{entry.title}</span>
      {entry.state === "overdue" && <span className="cal-tag is-overdue">过期</span>}
      {entry.state === "in-progress" && <span className="cal-tag is-progress">进行中</span>}
    </li>
  );
}

function GroupCard({ group, expanded, onToggle }: { group: CalendarTodoGroup; expanded: boolean; onToggle: () => void }) {
  const done = group.todos.filter(t => t.state === "completed").length;
  const open = group.todos.length - done;
  return (
    <section className={`cal-group ${expanded ? "is-open" : ""}`} data-source={group.source}>
      <button type="button" className="cal-group-head" onClick={onToggle} aria-expanded={expanded}>
        <span className="cal-group-dot" data-source={group.source} aria-hidden="true" />
        <span className="cal-group-title" title={group.title}>{group.title}</span>
        <span className="cal-group-count">{open > 0 ? `${open} 待办` : "全部完成"}{done > 0 ? ` · ${done} 完成` : ""}</span>
        <ChevronDown size={15} className="cal-group-chev" aria-hidden="true" />
      </button>
      {expanded && (
        <div className="cal-group-body">
          {group.cwd && <p className="cal-group-cwd" title={group.cwd}>{group.cwd}</p>}
          <ul className="cal-group-todos">{group.todos.map(todo => <TodoRow key={todo.id} entry={todo} />)}</ul>
        </div>
      )}
    </section>
  );
}

export default function CalendarView({ loadOverview }: { loadOverview: CalendarLoader }) {
  const today = new Date();
  const todayKey = localDateKey(today.getTime());
  const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() });
  const [overview, setOverview] = useState<CalendarOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedKey, setSelectedKey] = useState(todayKey);
  const [kind, setKind] = useState<KindFilter>("all");
  const [activeSources, setActiveSources] = useState<Set<CalendarSourceId>>(() => new Set(CALENDAR_SOURCES));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showUnscheduled, setShowUnscheduled] = useState(true);
  const rangeRef = useRef({ from: "", to: "" });
  const aliveRef = useRef(true);

  const grid = useMemo(() => buildGrid(cursor.year, cursor.month), [cursor]);
  const from = grid[0]!.key;
  const to = grid[41]!.key;
  rangeRef.current = { from, to };

  const load = useCallback(async (mode: "initial" | "refresh") => {
    const { from: f, to: t } = rangeRef.current;
    if (mode === "initial") setLoading(true); else setRefreshing(true);
    try {
      const next = await loadOverview(f, t);
      if (!aliveRef.current) return;
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

  const matches = useCallback((entry: CalendarEntry) =>
    activeSources.has(entry.source) && (kind === "all" || entry.kind === kind), [activeSources, kind]);

  const dayEntries = useMemo(() => {
    const map = new Map<string, CalendarEntry[]>();
    if (!overview) return map;
    for (const [key, entries] of Object.entries(overview.days)) {
      const filtered = entries.filter(matches);
      if (filtered.length) map.set(key, filtered);
    }
    return map;
  }, [overview, matches]);

  const stats = useMemo(() => {
    let scheduled = 0, completed = 0, overdue = 0, paused = 0, failed = 0, inProgress = 0;
    const count = (entry: CalendarEntry) => {
      if (!activeSources.has(entry.source)) return;
      if (entry.kind === "cron" && entry.state === "upcoming") scheduled++;
      if (entry.state === "completed") completed++;
      if (entry.state === "overdue") overdue++;
      if (entry.state === "paused") paused++;
      if (entry.state === "failed") failed++;
      if (entry.state === "in-progress") inProgress++;
    };
    if (overview) {
      for (const entries of Object.values(overview.days)) entries.forEach(count);
      for (const group of overview.unscheduled) group.todos.forEach(count);
    }
    return { scheduled, completed, overdue, paused, failed, inProgress };
  }, [overview, activeSources]);

  const selectedEntries = dayEntries.get(selectedKey) ?? [];
  const unscheduledGroups = useMemo(() =>
    (overview?.unscheduled ?? []).filter(group => activeSources.has(group.source) && (kind === "all" || kind === "todo")),
    [overview, activeSources, kind]);
  const unscheduledSchedules = useMemo(() =>
    (overview?.unscheduledSchedules ?? []).filter(entry => activeSources.has(entry.source) && (kind === "all" || kind === "cron")),
    [overview, activeSources, kind]);
  const sourceErrors = useMemo(() =>
    overview ? CALENDAR_SOURCES.filter(source => !overview.sources[source]?.ok).map(source => ({ source, error: overview.sources[source]?.error ?? "" })) : [],
    [overview]);
  const totalTodos = unscheduledGroups.reduce((sum, group) => sum + group.todos.length, 0);

  const toggleSource = (source: CalendarSourceId) => {
    setActiveSources(current => {
      const next = new Set(current);
      if (next.has(source)) next.delete(source); else next.add(source);
      return next;
    });
  };
  const toggleGroup = (id: string) => {
    setExpanded(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedDate = new Date(`${selectedKey}T00:00:00`);
  const selectedLabel = `${selectedDate.getMonth() + 1} 月 ${selectedDate.getDate()} 日 · 周${WEEKDAYS[(selectedDate.getDay() + 6) % 7]}`;

  return (
    <div className="cal-root">
      <div className="cal-aurora" aria-hidden="true" />
      <header className="cal-header">
        <div className="cal-title">
          <span className="cal-title-icon"><CalendarDays size={20} aria-hidden="true" /></span>
          <div>
            <h1>智能体日历</h1>
            <p>所有 Agent 的定时任务 · 执行记录 · 待办，一屏尽览</p>
          </div>
        </div>
        <div className="cal-nav">
          <button type="button" className="cal-nav-btn" aria-label="上个月" onClick={() => shiftMonth(-1)}><ChevronLeft size={18} /></button>
          <button type="button" className="cal-month" onClick={goToday} title="回到今天">{monthLabel(cursor.year, cursor.month)}</button>
          <button type="button" className="cal-nav-btn" aria-label="下个月" onClick={() => shiftMonth(1)}><ChevronRight size={18} /></button>
          <button type="button" className="cal-today-btn" onClick={goToday}>今天</button>
          <button type="button" className={`cal-refresh ${refreshing ? "is-spinning" : ""}`} aria-label="刷新" title="刷新" onClick={() => void load("refresh")}><RefreshCw size={15} /></button>
        </div>
      </header>

      <div className="cal-stats">
        <span className="cal-stat is-scheduled"><Timer size={14} />{stats.scheduled} 待执行</span>
        <span className="cal-stat is-progress"><CircleDot size={14} />{stats.inProgress} 进行中</span>
        <span className="cal-stat is-done"><Check size={14} />{stats.completed} 已完成</span>
        <span className="cal-stat is-overdue"><AlertTriangle size={14} />{stats.overdue} 过期</span>
        <span className="cal-stat is-paused"><Pause size={14} />{stats.paused} 暂停</span>
        {stats.failed > 0 && <span className="cal-stat is-fail"><X size={14} />{stats.failed} 失败</span>}
      </div>

      <div className="cal-filters">
        <div className="cal-sources" role="group" aria-label="按来源筛选">
          {CALENDAR_SOURCES.map(source => (
            <button key={source} type="button" data-source={source}
              className={`cal-source-chip ${activeSources.has(source) ? "is-on" : "is-off"}`}
              onClick={() => toggleSource(source)} aria-pressed={activeSources.has(source)}>
              <span className="cal-source-dot" aria-hidden="true" />{CALENDAR_SOURCE_LABELS[source]}
              {overview && <span className="cal-source-n">{overview.sources[source]?.entries + overview.sources[source]?.todos || 0}</span>}
            </button>
          ))}
        </div>
        <div className="cal-kind-seg" role="group" aria-label="按类型筛选">
          {(Object.keys(KIND_LABEL) as KindFilter[]).map(value => (
            <button key={value} type="button" className={kind === value ? "is-active" : ""} onClick={() => setKind(value)} aria-pressed={kind === value}>{KIND_LABEL[value]}</button>
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
                      {shown.map(entry => <Chip key={entry.id} entry={entry} onClick={() => setSelectedKey(cell.key)} />)}
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
              <div className="cal-empty"><Inbox size={28} strokeWidth={1.4} /><p>这一天没有安排</p><small>点击其他日期查看定时任务与待办</small></div>
            ) : selectedEntries.map(entry => <EntryRow key={entry.id} entry={entry} />)}
          </div>
        </aside>
      </div>

      <section className={`cal-unscheduled ${showUnscheduled ? "is-open" : ""}`}>
        <button type="button" className="cal-unscheduled-head" onClick={() => setShowUnscheduled(value => !value)} aria-expanded={showUnscheduled}>
          <ListTodo size={16} />
          <span>未安排</span>
          <span className="cal-unscheduled-n">{totalTodos} 待办 · {unscheduledGroups.length} 会话{unscheduledSchedules.length ? ` · ${unscheduledSchedules.length} 未排期任务` : ""}</span>
          <ChevronDown size={16} className="cal-unscheduled-chev" />
        </button>
        {showUnscheduled && (
          <div className="cal-unscheduled-body">
            {unscheduledSchedules.length > 0 && (
              <div className="cal-unsched-schedules">
                <h3><CalendarClock size={14} />未排期的定时任务</h3>
                <div className="cal-unsched-schedule-list">
                  {unscheduledSchedules.map(entry => (
                    <div key={entry.id} className="cal-unsched-schedule" data-source={entry.source}>
                      <span className="cal-entry-src" data-source={entry.source}>{CALENDAR_SOURCE_LABELS[entry.source]}</span>
                      <strong>{entry.title}</strong>
                      {entry.detail && <p>{entry.detail}</p>}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {unscheduledGroups.length === 0 && unscheduledSchedules.length === 0 ? (
              <div className="cal-empty is-inline"><Inbox size={24} strokeWidth={1.4} /><p>没有未安排的待办</p></div>
            ) : (
              <div className="cal-groups">
                {unscheduledGroups.map(group => <GroupCard key={group.id} group={group} expanded={expanded.has(group.id)} onToggle={() => toggleGroup(group.id)} />)}
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}