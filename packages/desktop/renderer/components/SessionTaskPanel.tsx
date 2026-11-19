import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Circle, FileDiff, GitBranch, GripVertical, ListChecks, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { SessionToolResultBody, SessionToolResultRef } from "@agent/core";
import type { TodoItem } from "../stores/agentStore";
import { loadSessionChangeHistory } from "../lib/session-change-history";
import { groupTurnChanges, type TurnFileChange } from "../lib/session-turn-results";
import { taskPanelPixels, taskPanelPosition, type TaskPanelBounds, type TaskPanelPosition } from "../lib/session-task-panel-state";
import { TurnChangeDetails, TurnResultDisclosure } from "./SessionTurnResults";
import "../styles/session-task-panel.css";

interface SessionTaskPanelProps {
  id?: string;
  sessionId: string | null;
  workspacePath: string | null;
  visibleChanges: TurnFileChange[];
  todos: TodoItem[];
  running: boolean;
  onLoadResult: (ref: SessionToolResultRef) => Promise<SessionToolResultBody>;
  onOpenArtifact?: (path: string) => void;
  onHide?: () => void;
  position?: TaskPanelPosition | null;
  onPositionChange?: (position: TaskPanelPosition) => void;
}

const DIRECTION_KEYS: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };

export function SessionTaskPanelToggle({ visible, panelId, onToggle }: { visible: boolean; panelId: string; onToggle: () => void }) {
  const label = visible ? "隐藏变更与计划" : "显示变更与计划";
  return <button type="button" className="ui-icon-button chat-task-panel-toggle" onClick={onToggle}
    title={label} aria-label={label} aria-pressed={visible} aria-controls={panelId}
    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
    <ListChecks size={16} aria-hidden="true" />
  </button>;
}

export default function SessionTaskPanel({ id, sessionId, workspacePath, visibleChanges, todos, running, onLoadResult, onOpenArtifact, onHide, position = null, onPositionChange }: SessionTaskPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<TurnFileChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [bounds, setBounds] = useState<TaskPanelBounds | null>(null);
  const [dragPosition, setDragPosition] = useState<TaskPanelPosition | null>(null);
  const drag = useRef<{ pointerId: number; offset: TaskPanelPosition; position: TaskPanelPosition | null } | null>(null);
  const contentId = useId();
  const recordedChanges = new Map((snapshot ?? []).map(change => [JSON.stringify([change.tool.id, change.path]), change]));
  for (const change of visibleChanges) {
    const key = JSON.stringify([change.tool.id, change.path]);
    if (!recordedChanges.has(key)) recordedChanges.set(key, change);
  }
  const changes = [...recordedChanges.values()];
  const files = groupTurnChanges(changes);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    const frame = panel?.parentElement;
    if (!panel || !frame) return;
    const measure = () => {
      const next = { width: frame.clientWidth, height: frame.clientHeight, panelWidth: panel.offsetWidth, panelHeight: panel.offsetHeight };
      setBounds(current => current && Object.keys(next).every(key => current[key as keyof TaskPanelBounds] === next[key as keyof TaskPanelBounds]) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(panel); observer.observe(frame);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [expanded, snapshot, visibleChanges, error, todos]);

  const finishDrag = (event: ReactPointerEvent<HTMLElement>, save: boolean) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (save && current.position) onPositionChange?.(current.position);
    setDragPosition(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const effectivePosition = dragPosition ?? position;
  const placement = effectivePosition && bounds ? taskPanelPixels(effectivePosition, bounds) : null;

  useEffect(() => {
    if (!expanded || !sessionId || !window.agentApi) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void loadSessionChangeHistory(window.agentApi, sessionId, workspacePath, controller.signal)
      .then(result => { if (!controller.signal.aborted) setSnapshot(result); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取变更失败，请重试"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => { controller.abort(); setLoading(false); };
  }, [expanded, refresh, running, sessionId, workspacePath]);

  const complete = todos.filter(todo => todo.status === "completed").length;
  const current = todos.find(todo => todo.status === "in-progress") ?? todos.find(todo => todo.status === "pending");
  const completedTitles = new Set(todos.filter(todo => todo.status === "completed").map(todo => todo.title.toLowerCase()));
  const name = workspacePath?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "当前会话";
  const added = changes.reduce((sum, change) => sum + (change.stats?.added ?? 0), 0);
  const removed = changes.reduce((sum, change) => sum + (change.stats?.removed ?? 0), 0);
  const hasCounts = changes.some(change => change.stats);
  const changesLabel = error ? "读取失败"
    : !sessionId ? "暂无会话"
    : loading ? "读取中…"
    : snapshot ? files.size ? `${files.size} 项` : "暂无变更"
    : files.size ? `已加载 ${files.size} 项` : "查看全部";

  return <aside id={id} ref={panelRef} className={`session-task-panel${expanded ? " is-expanded" : ""}${dragPosition ? " is-dragging" : ""}`} aria-label="变更与计划"
    style={placement ? { left: placement.x, top: placement.y, right: "auto" } : undefined}
    onKeyDown={event => {
      if (event.key === "Escape" && expanded) { event.stopPropagation(); setExpanded(false); toggleRef.current?.focus(); }
    }}>
    <div className="session-task-panel__header">
      <div className="session-task-panel__drag-handle" role="button" tabIndex={0} aria-label="拖动变更与计划面板" title="拖动面板；方向键调整位置"
        onPointerDown={event => {
          if (event.button !== 0 || !panelRef.current || !onPositionChange) return;
          event.preventDefault();
          const panel = panelRef.current.getBoundingClientRect();
          drag.current = { pointerId: event.pointerId, offset: { x: event.clientX - panel.left, y: event.clientY - panel.top }, position: null };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => {
          const current = drag.current;
          const frame = panelRef.current?.parentElement?.getBoundingClientRect();
          if (!current || current.pointerId !== event.pointerId || !bounds || !frame) return;
          current.position = taskPanelPosition({ x: event.clientX - frame.left - current.offset.x, y: event.clientY - frame.top - current.offset.y }, bounds);
          setDragPosition(current.position);
        }}
        onPointerUp={event => finishDrag(event, true)} onPointerCancel={event => finishDrag(event, false)}
        onLostPointerCapture={event => finishDrag(event, false)}
        onKeyDown={event => {
          const delta = DIRECTION_KEYS[event.key];
          const panel = panelRef.current?.getBoundingClientRect();
          const frame = panelRef.current?.parentElement?.getBoundingClientRect();
          if (!delta || !panel || !frame || !bounds || !onPositionChange) return;
          event.preventDefault();
          onPositionChange(taskPanelPosition({ x: panel.left - frame.left + delta[0], y: panel.top - frame.top + delta[1] }, bounds));
        }}>
        <GripVertical size={13} aria-hidden="true" />
        <span className="session-task-panel__workspace" title={workspacePath ?? undefined}>{name}</span>
      </div>
      <span className="session-task-panel__caption">变更与计划</span>
      <button ref={toggleRef} type="button" className="session-task-panel__toggle" aria-expanded={expanded}
      aria-controls={contentId} aria-label={expanded ? "收起变更与计划" : "展开变更与计划"}
      onClick={() => setExpanded(value => !value)}>
      {expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
      </button>
      {onHide && <button type="button" className="session-task-panel__hide" aria-label="隐藏变更与计划" title="隐藏面板，可从会话标题旁重新打开" onClick={onHide}><X size={14} aria-hidden="true" /></button>}
    </div>
    <button type="button" className="session-task-panel__summary" aria-expanded={expanded} aria-controls={contentId}
      aria-label={expanded ? "收起变更与计划详情" : "查看变更与计划详情"} onClick={() => setExpanded(value => !value)}>
      <span className="session-task-panel__change-summary"><FileDiff size={15} aria-hidden="true" /><span>会话变更</span>
        <span className="session-task-panel__muted">{changesLabel}</span>
      </span>
      {hasCounts && !error && <span className="session-task-panel__counts" title="执行记录中可统计的累计增删行数" aria-label={`累计新增 ${added} 行，删除 ${removed} 行`}>
        <span className="session-task-panel__added">+{added}</span><span className="session-task-panel__removed">−{removed}</span>
      </span>}
    </button>
    {!expanded && todos.length > 0 && <button type="button" className="session-task-panel__current" onClick={() => setExpanded(true)}
      aria-label="展开执行计划" aria-expanded={false} aria-controls={contentId}>
      {current ? <ArrowRight size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
      <span title={current?.title}>{current?.title ?? "计划已完成"}</span><span>{complete}/{todos.length}</span>
    </button>}
    {expanded && <div id={contentId} className="session-task-panel__body">
      <section className="session-task-panel__section" aria-label="会话变更">
        <div className="session-task-panel__section-heading">
          <span className="session-task-panel__branch"><GitBranch size={14} aria-hidden="true" /><span>会话改动记录</span></span>
          <button type="button" className="session-task-panel__refresh" title="刷新变更" aria-label="刷新变更"
            disabled={loading || !sessionId} onClick={() => setRefresh(value => value + 1)}>
            {loading ? <LoaderCircle size={14} className="session-task-panel__spinner" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          </button>
        </div>
        {error && <div className="session-task-panel__empty" role="status">{error}<button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></div>}
        {!files.size ? !error && <p className="session-task-panel__empty">{changesLabel}</p>
          : <ul className="session-task-panel__files" aria-label="变更文件">
            {[...files].map(([path, entries]) => {
              const displayPath = path.replaceAll("\\", "/");
              const split = displayPath.lastIndexOf("/");
              return <li key={path}><TurnResultDisclosure title={path} summaryClassName="session-task-panel__file" label={<>
                <span className="session-task-panel__filename">
                  <span className="session-task-panel__basename">{displayPath.slice(split + 1)}</span>
                  {split > 0 && <span className="session-task-panel__directory">{displayPath.slice(0, split)}</span>}
                </span>
                <span className="session-task-panel__file-status">{entries.length} 次改动</span>
              </>}><TurnChangeDetails changes={entries} onLoadResult={onLoadResult} onOpenArtifact={onOpenArtifact} /></TurnResultDisclosure></li>;
            })}
          </ul>}
      </section>
      <section className="session-task-panel__section" aria-label="执行计划">
        <div className="session-task-panel__section-heading"><span><ListChecks size={15} aria-hidden="true" />计划</span>
          <span className="session-task-panel__muted">{todos.length ? `${complete}/${todos.length}` : "暂无计划"}</span>
        </div>
        {todos.length > 0 ? <ol className="session-task-panel__plan">
          {todos.map(todo => {
            const blocked = todo.status === "pending" && todo.dependsOn?.some(dependency => !completedTitles.has(dependency.toLowerCase()));
            const label = todo.status === "completed" ? "已完成" : todo.status === "in-progress" ? "进行中" : blocked ? "等待前置" : "待开始";
            const Icon = todo.status === "completed" ? CheckCircle2 : todo.status === "in-progress" ? ArrowRight : Circle;
            return <li key={todo.id} className={`session-task-panel__step is-${todo.status}`}>
              <Icon size={16} aria-label={label} /><span className="session-task-panel__step-title">{todo.title}</span>
              {(blocked || todo.agentName) && <span className="session-task-panel__step-meta" title={blocked ? `等待：${todo.dependsOn?.join("、")}` : undefined}>{blocked ? "等待前置" : `@${todo.agentName}`}</span>}
            </li>;
          })}
        </ol> : <p className="session-task-panel__empty">Agent 创建计划后会显示在这里</p>}
      </section>
    </div>}
  </aside>;
}
