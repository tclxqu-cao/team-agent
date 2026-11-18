import { CalendarDays, LayoutDashboard, ListTodo, MessageSquarePlus, Monitor, UsersRound } from "lucide-react";
import { TASK_PANE_SURFACE_LABELS, type TaskPaneSurfaceKind } from "./session-state";

const icons = { "remote-desktop": Monitor, groups: UsersRound, dashboard: LayoutDashboard, calendar: CalendarDays };

export default function TaskPaneChoices({ onTask, onDraft, onSurface }: {
  onTask(): void;
  onDraft(): void;
  onSurface(kind: TaskPaneSurfaceKind): void;
}) {
  return <div className="task-pane-choices">
    <button type="button" onClick={onTask}><ListTodo size={17} aria-hidden="true" /><span>选择任务</span></button>
    <button type="button" onClick={onDraft}><MessageSquarePlus size={17} aria-hidden="true" /><span>新建会话</span></button>
    {(Object.keys(TASK_PANE_SURFACE_LABELS) as TaskPaneSurfaceKind[]).map(kind => {
      const Icon = icons[kind];
      return <button type="button" key={kind} onClick={() => onSurface(kind)}><Icon size={17} aria-hidden="true" /><span>{TASK_PANE_SURFACE_LABELS[kind]}</span></button>;
    })}
  </div>;
}
