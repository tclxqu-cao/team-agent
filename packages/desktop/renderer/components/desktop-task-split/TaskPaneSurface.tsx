import { lazy, Suspense, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import type { AgentType } from "../../../../core/src/domain/agent/agent-type";
import type { MonitoredSession } from "../../../../core/src/domain/supervision/types";
import type { CalendarLoader } from "../CalendarView";
import SessionLoading from "../SessionLoading";
import type { TaskPaneSurfaceKind } from "./session-state";
import { isWebShell } from "../../web/webLayout";
import "./task-pane-surface.css";

const CalendarView = lazy(() => import("../CalendarView"));
const CollaborationDashboard = lazy(() => import("../collaboration/CollaborationDashboard"));
const CollaborationPage = lazy(() => import("../collaboration/CollaborationPage"));
const SessionDashboard = lazy(() => import("../collaboration/SessionDashboard"));
const DesktopLiveSettings = lazy(() => import("../DesktopLiveSettings"));
const BrowserLivePanel = lazy(() => import("../BrowserLivePanel"));
const TaskPaneTerminal = lazy(() => import("./TaskPaneTerminal"));

interface Props {
  kind: TaskPaneSurfaceKind;
  paneId: string;
  focused: boolean;
  cwd?: string;
  onOpenSession(session: MonitoredSession): void;
  onNewSession(): void;
  onChangeContent(): void;
  onSelectSurface(kind: TaskPaneSurfaceKind): void;
  onViewAgent?(agentType: AgentType): void;
  active?: boolean;
}

const loadCalendar: CalendarLoader = async (from, to) => {
  if (!window.agentApi?.calendarOverview) throw new Error("当前服务不支持日历，请更新共享服务。");
  return window.agentApi.calendarOverview({ from, to });
};

/** The same desktop features, with navigation scoped to the containing pane. */
export default function TaskPaneSurface({ kind, paneId, focused, cwd, onOpenSession, onNewSession, onChangeContent, onSelectSurface, onViewAgent, active = true }: Props) {
  const [group, setGroup] = useState<{ id: string; title: string; discussionId?: string } | null>(null);
  useEffect(() => { setGroup(null); }, [kind]);

  return <div className="task-pane-surface" data-pane-surface={kind}>
    {group && <nav className="task-pane-group-navigation" aria-label="群聊导航">
      <button type="button" onClick={() => setGroup(null)}><ArrowLeft size={14} aria-hidden="true" />{kind === "dashboard" ? "返回 Dashboard" : "返回群聊列表"}</button>
      <span title={group.title}>{group.title}</span>
    </nav>}
    <div className="task-pane-surface-body">
      <Suspense fallback={<SessionLoading label="正在打开面板" />}>
        {group ? <CollaborationPage key={`${group.id}:${group.discussionId ?? ""}`} groupId={group.id} initialDiscussionId={group.discussionId} />
          : kind === "calendar" ? <CalendarView loadOverview={loadCalendar} />
          : kind === "terminal" ? <TaskPaneTerminal paneId={paneId} active={active} focused={focused} />
          : kind === "remote-desktop" && isWebShell() ? <BrowserLivePanel open active={active} embedded onClose={onChangeContent} />
          : kind === "remote-desktop" ? <div className="task-pane-remote-desktop">
            {typeof window !== "undefined" && typeof window.agentApi?.desktopLiveGetStatus === "function" ? <DesktopLiveSettings />
              : <div className="task-pane-surface-unavailable"><p>当前客户端不支持远程桌面。</p><button type="button" onClick={onChangeContent}>选择其他内容</button></div>}
          </div>
          : kind === "groups" ? <CollaborationDashboard cwd={cwd}
            onOpen={item => setGroup({ id: item.id, title: item.name })}
            onViewDashboard={() => onSelectSurface("dashboard")} />
          : <SessionDashboard
            onOpenGroup={item => setGroup({ id: item.group.id, title: item.group.name, discussionId: item.discussionId })}
            onOpenSession={onOpenSession} onNewSession={onNewSession} onViewAgent={onViewAgent}
            onViewGroups={() => onSelectSurface("groups")} />}
      </Suspense>
    </div>
  </div>;
}
