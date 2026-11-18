import { useEffect, useId, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, ChevronUp, Circle, FileDiff, GitBranch, GripVertical, ListChecks, LoaderCircle, RefreshCw, X } from "lucide-react";
import type { WorkspaceChanges } from "../../../core/src/domain/file-workspace/workspace-changes";
import type { TodoItem } from "../stores/agentStore";
import { usePageActive } from "../lib/page-activity";
import { resolveWebArtifactPath } from "../lib/artifact-links";
import { taskPanelPixels, taskPanelPosition, type TaskPanelBounds, type TaskPanelPosition } from "../lib/session-task-panel-state";
import "../styles/session-task-panel.css";

interface SessionTaskPanelProps {
  id?: string;
  workspacePath: string | null;
  todos: TodoItem[];
  running: boolean;
  onOpenArtifact?: (path: string) => void;
  onHide?: () => void;
  position?: TaskPanelPosition | null;
  onPositionChange?: (position: TaskPanelPosition) => void;
}

const STATUS_LABELS = { modified: "修改", added: "新增", deleted: "删除", untracked: "未跟踪", conflict: "冲突" };
const DIRECTION_KEYS: Record<string, [number, number]> = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] };

export function SessionTaskPanelToggle({ visible, panelId, onToggle }: { visible: boolean; panelId: string; onToggle: () => void }) {
  const label = visible ? "隐藏变更与计划" : "显示变更与计划";
  return <button type="button" className="ui-icon-button chat-task-panel-toggle" onClick={onToggle}
    title={label} aria-label={label} aria-pressed={visible} aria-controls={panelId}
    style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}>
    <ListChecks size={16} aria-hidden="true" />
  </button>;
}

export async function fetchWorkspaceChanges(path: string): Promise<WorkspaceChanges> {
  const url = `/api/workspace-changes?${new URLSearchParams({ path })}`;
  const shared = window.sharedServiceApi;
  const response = shared?.request
    ? await shared.request(url, "GET")
    : await fetch(url, { cache: "no-store" }).then(async result => ({ status: result.status, body: await result.text() }));
  if (response.status === 404) throw new Error("当前后台尚未提供变更接口，请更新后台服务后重试");
  if (response.status === 401 || response.status === 403) throw new Error("没有读取变更的权限，请检查服务连接");
  let body: (WorkspaceChanges & { error?: string }) | null;
  try { body = JSON.parse(response.body); }
  catch { throw new Error("读取变更失败，请重试"); }
  if (response.status < 200 || response.status >= 300) throw new Error(body?.error || `读取变更失败（${response.status}）`);
  if (!body || typeof body.repository !== "boolean" || !Array.isArray(body.files)) throw new Error("后台返回的变更数据格式不正确，请重试");
  return body;
}

export default function SessionTaskPanel({ id, workspacePath, todos, running, onOpenArtifact, onHide, position = null, onPositionChange }: SessionTaskPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [changes, setChanges] = useState<WorkspaceChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [bounds, setBounds] = useState<TaskPanelBounds | null>(null);
  const [dragPosition, setDragPosition] = useState<TaskPanelPosition | null>(null);
  const drag = useRef<{ pointerId: number; offset: TaskPanelPosition; position: TaskPanelPosition | null } | null>(null);
  const contentId = useId();
  const active = usePageActive();

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
  }, [expanded, changes, error, todos]);

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
    if (!workspacePath || !active) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setLoading(true);
      try {
        const result = await fetchWorkspaceChanges(workspacePath);
        if (!disposed) { setChanges(result); setError(null); }
      } catch (failure) {
        if (!disposed) setError(failure instanceof Error ? failure.message : "读取变更失败，请重试");
      } finally {
        if (!disposed) {
          setLoading(false);
          timer = setTimeout(load, running ? 5_000 : expanded ? 15_000 : 30_000);
        }
      }
    };
    void load();
    return () => { disposed = true; clearTimeout(timer); };
  }, [active, expanded, refresh, running, workspacePath]);

  const complete = todos.filter(todo => todo.status === "completed").length;
  const current = todos.find(todo => todo.status === "in-progress") ?? todos.find(todo => todo.status === "pending");
  const completedTitles = new Set(todos.filter(todo => todo.status === "completed").map(todo => todo.title.toLowerCase()));
  const name = workspacePath?.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "当前会话";
  const added = changes?.files.reduce((sum, file) => sum + (file.added ?? 0), 0) ?? 0;
  const removed = changes?.files.reduce((sum, file) => sum + (file.removed ?? 0), 0) ?? 0;
  const hasCounts = changes?.files.some(file => file.added !== null || file.removed !== null);
  const changesLabel = error ? "读取失败"
    : !workspacePath ? "未选择目录"
    : !changes ? "读取中…"
    : !changes.repository ? "非 Git 目录"
    : changes.files.length ? `${changes.files.length} 项` : "暂无变更";

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
      <span className="session-task-panel__change-summary"><FileDiff size={15} aria-hidden="true" /><span>变更</span>
        <span className="session-task-panel__muted">{changesLabel}</span>
      </span>
      {hasCounts && !error && <span className="session-task-panel__counts" title="已跟踪文本的增删行数；未跟踪和二进制文件另列" aria-label={`已跟踪文本新增 ${added} 行，删除 ${removed} 行`}>
        <span className="session-task-panel__added">+{added}</span><span className="session-task-panel__removed">−{removed}</span>
      </span>}
    </button>
    {!expanded && todos.length > 0 && <button type="button" className="session-task-panel__current" onClick={() => setExpanded(true)}
      aria-label="展开执行计划" aria-expanded={false} aria-controls={contentId}>
      {current ? <ArrowRight size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />}
      <span title={current?.title}>{current?.title ?? "计划已完成"}</span><span>{complete}/{todos.length}</span>
    </button>}
    {expanded && <div id={contentId} className="session-task-panel__body">
      <section className="session-task-panel__section" aria-label="工作区变更">
        <div className="session-task-panel__section-heading">
          <span className="session-task-panel__branch"><GitBranch size={14} aria-hidden="true" /><span>{changes?.branch ?? (changes?.repository ? "分离 HEAD" : "工作目录")}</span></span>
          <button type="button" className="session-task-panel__refresh" title="刷新变更" aria-label="刷新变更"
            disabled={loading || !workspacePath} onClick={() => setRefresh(value => value + 1)}>
            {loading ? <LoaderCircle size={14} className="session-task-panel__spinner" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />}
          </button>
        </div>
        {error ? <div className="session-task-panel__empty" role="status">{error}<button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button></div>
          : !changes?.files.length ? <p className="session-task-panel__empty">{changesLabel}</p>
          : <ul className="session-task-panel__files" aria-label="变更文件">
            {changes.files.map(file => {
              const path = resolveWebArtifactPath(file.path, changes.root);
              const displayPath = file.path.replace(/\/$/, "");
              const split = displayPath.lastIndexOf("/");
              const content = <><span className="session-task-panel__filename">
                <span className="session-task-panel__basename">{displayPath.slice(split + 1)}{file.path.endsWith("/") ? "/" : ""}</span>
                {split > 0 && <span className="session-task-panel__directory">{displayPath.slice(0, split)}</span>}
              </span>
                <span className="session-task-panel__file-status">{STATUS_LABELS[file.status]}</span>
                {file.added !== null && file.removed !== null && <span className="session-task-panel__counts">
                  <span className="session-task-panel__added">+{file.added}</span><span className="session-task-panel__removed">−{file.removed}</span>
                </span>}</>;
              return <li key={file.path}>{onOpenArtifact && path && file.status !== "deleted" && !file.path.endsWith("/")
                ? <button type="button" className="session-task-panel__file" title={file.path} aria-label={`预览 ${file.path}`} onClick={() => onOpenArtifact(path)}>{content}</button>
                : <div className="session-task-panel__file" title={file.path}>{content}</div>}</li>;
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
