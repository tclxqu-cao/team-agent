import { isAgentType } from "../../../../core/src/domain/agent/agent-type";
import type { CatalogSession } from "../../../../core/src/domain/supervision/types";
import type { AgentType, AgentWorkspace, UnifiedSessionSummary } from "../../global";
import type { SessionHistoryDetail, SessionHistorySeed } from "../../lib/session-history";
import { appendTaskColumn, fourColumnTaskLayout, insertTaskPane, readTaskLayout, removeTaskPane, taskPaneIds, type TaskSplitNode } from "../../lib/desktop-task-layout";

export interface TaskPaneDraft {
  agentType: AgentType;
  projectId: string | null;
  cwd: string;
  workspaceSource?: AgentWorkspace["source"];
}

/** Keep looking for the requested directory before falling back on the final page. */
export function resolveTaskDraftWorkspace(draft: TaskPaneDraft, workspaces: AgentWorkspace[], complete: boolean): AgentWorkspace | undefined {
  const available = workspaces.filter(item => item.canCreateSession !== false);
  return available.find(item => item.workspaceId === draft.projectId)
    ?? available.find(item => item.roots.includes(draft.cwd))
    ?? (complete && (draft.agentType === "customer-agent" || !draft.cwd) ? available[0] : undefined);
}

export const TASK_PANE_SURFACE_LABELS = {
  "remote-desktop": "远程桌面",
  groups: "群聊",
  dashboard: "Dashboard",
  calendar: "日历 / 待办",
  terminal: "终端",
} as const;
export type TaskPaneSurfaceKind = keyof typeof TASK_PANE_SURFACE_LABELS;

interface TaskPaneContent {
  session: UnifiedSessionSummary | null;
  initialHistory?: SessionHistorySeed;
  draft?: TaskPaneDraft;
  surface?: TaskPaneSurfaceKind;
  webUrl?: string;
  temporary?: true;
}

export interface TaskPane extends TaskPaneContent {
  id: string;
  history?: TaskPaneContent[];
}

export function isEmptyTaskPane(pane: TaskPaneContent): boolean {
  return !pane.session && !pane.draft && !pane.surface && !pane.webUrl;
}

function withPaneContent(pane: TaskPane, next: TaskPaneContent, push: boolean): TaskPane {
  const { id, history, ...previous } = pane;
  const stack = push && !isEmptyTaskPane(previous) ? [...(history ?? []), previous] : history;
  return { id, ...next, ...(stack?.length ? { history: stack } : {}) };
}

/** Links only claim unused panes, with the focused empty pane taking priority. */
export function openTaskWorkspaceWebPage(state: TaskWorkspaceSnapshot, url: string): TaskWorkspaceSnapshot | null {
  try { if (!["http:", "https:"].includes(new URL(url).protocol)) return null; } catch { return null; }
  const active = state.panes.find(pane => pane.id === state.activePaneId);
  const byId = new Map(state.panes.map(pane => [pane.id, pane]));
  const empty = active && isEmptyTaskPane(active) ? active : taskPaneIds(state.layout).map(id => byId.get(id)!).find(isEmptyTaskPane);
  return empty ? { ...updateTaskPaneContent(state, empty.id, { webUrl: url }), activePaneId: empty.id } : null;
}

export function updateTaskPaneContent(state: TaskWorkspaceSnapshot, paneId: string, content: { surface: TaskPaneSurfaceKind } | { webUrl: string } | null): TaskWorkspaceSnapshot {
  if (!state.panes.some(pane => pane.id === paneId)) return state;
  return { ...state, panes: state.panes.map(pane => {
    if (pane.id !== paneId) return pane;
    if (!content) return { id: pane.id, session: null };
    if (("surface" in content && pane.surface === content.surface) || ("webUrl" in content && pane.webUrl === content.webUrl)) return pane;
    return withPaneContent(pane, { session: null, ...content }, true);
  }) };
}

export interface TaskWorkspaceSnapshot {
  panes: TaskPane[];
  layout: TaskSplitNode;
  activePaneId: string;
  layoutMode?: "four-columns" | "columns";
}

export function taskPaneHistorySeed(pane: TaskPane, navigation?: SessionHistorySeed): SessionHistorySeed | undefined {
  return navigation?.sessionId === pane.session?.id ? navigation : pane.initialHistory;
}

export function fourColumnTaskWorkspace(state: TaskWorkspaceSnapshot, createId: () => string): TaskWorkspaceSnapshot {
  const panes = [...state.panes];
  while (panes.length < 4) panes.push({ id: createId(), session: null });
  return { ...state, panes, layout: fourColumnTaskLayout(panes.map(pane => pane.id))!, layoutMode: "four-columns" };
}

export function addTaskWorkspaceColumn(state: TaskWorkspaceSnapshot, paneId: string): TaskWorkspaceSnapshot {
  return { ...state, panes: [...state.panes, { id: paneId, session: null }], activePaneId: paneId,
    layout: appendTaskColumn(state.layout, paneId), layoutMode: "columns" };
}

export function updateTaskPaneDraft(state: TaskWorkspaceSnapshot, paneId: string, draft: TaskPaneDraft, start = false): TaskWorkspaceSnapshot {
  if (!state.panes.some(pane => pane.id === paneId && (start || !pane.session))) return state;
  return { ...state, panes: state.panes.map(pane => pane.id === paneId
    ? withPaneContent(pane, { session: null, draft }, !pane.draft) : pane) };
}

export function addTaskWorkspaceSession(state: TaskWorkspaceSnapshot, session: UnifiedSessionSummary, newId: string): { state: TaskWorkspaceSnapshot; paneId: string } {
  const byId = new Map(state.panes.map(pane => [pane.id, pane]));
  const empty = taskPaneIds(state.layout).map(id => byId.get(id)!).find(isEmptyTaskPane);
  if (empty) return { paneId: empty.id, state: { ...state, activePaneId: empty.id,
    panes: state.panes.map(pane => pane.id === empty.id ? { ...pane, session, initialHistory: undefined } : pane) } };
  return { paneId: newId, state: { ...state, activePaneId: newId,
    panes: [...state.panes, { id: newId, session }],
    layout: insertTaskPane(state.layout, newId, state.activePaneId, state.layoutMode ? "rows" : "columns") } };
}

/** A delayed replacement updates its own view without stealing focus or resizing siblings. */
export function updateTaskPaneSession(state: TaskWorkspaceSnapshot, paneId: string, session: UnifiedSessionSummary, initialHistory?: SessionHistorySeed): TaskWorkspaceSnapshot {
  const pane = state.panes.find(item => item.id === paneId);
  if (!pane) return state;
  const isCurrent = pane.session?.id === session.id;
  const next = isCurrent ? { ...pane, session, initialHistory: initialHistory ?? pane.initialHistory }
    : withPaneContent(pane, { session, initialHistory }, !pane.draft);
  return { ...state, panes: state.panes.map(item => item === pane ? next : item) };
}

/** Temporarily replace exactly the pane selected when the notification was clicked. */
export function pushTaskPaneNotification(state: TaskWorkspaceSnapshot, paneId: string, session: UnifiedSessionSummary, initialHistory?: SessionHistorySeed): TaskWorkspaceSnapshot {
  const current = state.panes.find(pane => pane.id === paneId);
  if (!current || (current.session?.id === session.id && current.session.agentType === session.agentType)) return state;
  const next = withPaneContent(current, { session, initialHistory, temporary: true }, true);
  return { ...state, panes: state.panes.map(pane => pane === current ? next : pane) };
}

/** Keep the same layout leaf until its last view has closed. */
export function closeTaskWorkspacePane(state: TaskWorkspaceSnapshot, paneId: string): TaskWorkspaceSnapshot | null {
  const current = state.panes.find(pane => pane.id === paneId);
  if (!current) return state;
  if (current.history?.length) {
    const history = current.history.slice(0, -1);
    const next = { id: paneId, ...current.history[current.history.length - 1], ...(history.length ? { history } : {}) };
    return { ...state, panes: state.panes.map(pane => pane === current ? next : pane) };
  }
  const layout = removeTaskPane(state.layout, paneId);
  if (!layout) return null;
  const panes = state.panes.filter(pane => pane !== current);
  return { ...state, panes, layout, activePaneId: state.activePaneId === paneId ? taskPaneIds(layout)[0] : state.activePaneId };
}

export function catalogTaskSession(target: CatalogSession): UnifiedSessionSummary {
  return {
    ...target, nativeSessionId: target.id.startsWith(`runtime:${target.agentType}:`)
      ? target.id.slice(`runtime:${target.agentType}:`.length) : target.id,
    created: target.updated, sourceLabel: target.agentType,
    occupancy: target.occupancy ?? "available", canDelete: false,
  };
}

export async function loadTaskSession(target: { id: string; agentType?: UnifiedSessionSummary["agentType"] }): Promise<Pick<TaskPane, "session" | "initialHistory">> {
  const detail = await window.agentApi.getSession(target.id, target.agentType === "codex" || target.id.startsWith("runtime:codex:")
    ? { view: "core", limit: 1 } : { limit: 30 }) as UnifiedSessionSummary & SessionHistoryDetail;
  if (detail?.id !== target.id || !isAgentType(detail.agentType) || (target.agentType && detail.agentType !== target.agentType)) throw new Error("会话身份已变化，请重新选择任务");
  const { messages: _messages, events: _events, history: _history, ...session } = detail;
  return { session, initialHistory: { sessionId: session.id, detail } };
}

function readPaneContent(value: unknown): TaskPaneContent | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.session === null) {
    if (candidate.surface !== undefined) {
      if (typeof candidate.surface !== "string" || !Object.hasOwn(TASK_PANE_SURFACE_LABELS, candidate.surface)
        || candidate.draft !== undefined || candidate.webUrl !== undefined) return null;
      return { session: null, surface: candidate.surface as TaskPaneSurfaceKind };
    }
    if (candidate.webUrl !== undefined) {
      if (typeof candidate.webUrl !== "string" || candidate.draft !== undefined) return null;
      try { if (!["http:", "https:"].includes(new URL(candidate.webUrl).protocol)) return null; } catch { return null; }
      return { session: null, webUrl: candidate.webUrl };
    }
    if (candidate.draft === undefined) return { session: null };
    if (!candidate.draft || typeof candidate.draft !== "object") return null;
    const draft = candidate.draft as Record<string, unknown>;
    if (!isAgentType(draft.agentType) || typeof draft.cwd !== "string"
      || (draft.projectId !== null && typeof draft.projectId !== "string")
      || (draft.workspaceSource !== undefined && draft.workspaceSource !== "native"
        && draft.workspaceSource !== "derived" && draft.workspaceSource !== "imported")) return null;
    return { session: null, draft: {
      agentType: draft.agentType, projectId: draft.projectId, cwd: draft.cwd, workspaceSource: draft.workspaceSource,
    } };
  }
  if (!candidate.session || typeof candidate.session !== "object"
    || candidate.draft !== undefined || candidate.surface !== undefined || candidate.webUrl !== undefined) return null;
  const session = candidate.session as Record<string, unknown>;
  if (typeof session.id !== "string" || !session.id || !isAgentType(session.agentType)
    || typeof session.title !== "string" || typeof session.cwd !== "string") return null;
  return { session: catalogTaskSession({
    id: session.id, agentType: session.agentType, title: session.title, cwd: session.cwd,
    projectId: typeof session.projectId === "string" ? session.projectId : undefined,
    updated: typeof session.updated === "string" ? session.updated : "",
    status: "idle", canResume: true,
  }) };
}

export function readTaskWorkspace(value: unknown): TaskWorkspaceSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const saved = value as Record<string, unknown>;
  if (saved.version !== 1 && saved.version !== 2) return null;
  if (!Array.isArray(saved.panes) || saved.panes.length === 0 || saved.panes.length > 128) return null;
  const panes: TaskPane[] = [];
  const legacySessions = new Set<string>();
  for (const candidate of saved.panes) {
    if (!candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || !candidate.id) return null;
    const content = readPaneContent(candidate);
    if (!content) return null;
    if (saved.version === 1 && content.session) {
      if (legacySessions.has(content.session.id)) return null;
      legacySessions.add(content.session.id);
    }
    // Invalid older entries can be discarded without losing the visible layout.
    const history: TaskPaneContent[] = [];
    if (saved.version === 2 && Array.isArray(candidate.history)) {
      for (const entry of candidate.history) {
        const previous = readPaneContent(entry);
        if (previous && !isEmptyTaskPane(previous)) history.push(previous);
      }
    }
    panes.push({ id: candidate.id, ...content, ...(history.length ? { history } : {}) });
  }
  const layout = readTaskLayout(saved.layout, panes.map(pane => pane.id));
  return layout ? { panes, layout, activePaneId: panes.some(pane => pane.id === saved.activePaneId) ? saved.activePaneId as string : panes[0].id,
    ...(saved.layoutMode === "four-columns" || saved.layoutMode === "columns" ? { layoutMode: saved.layoutMode } : {}) } : null;
}

function serializePaneContent(pane: TaskPaneContent) {
  const session = pane.session;
  return {
    surface: pane.surface,
    webUrl: pane.webUrl,
    draft: pane.draft,
    session: session ? {
      id: session.id, agentType: session.agentType, title: session.title,
      cwd: session.cwd, projectId: session.projectId, updated: session.updated,
    } : null,
  };
}

/** Save navigation summaries while keeping temporary notification views and transcripts in memory. */
export function serializeTaskWorkspace(state: TaskWorkspaceSnapshot): string {
  return JSON.stringify({ version: 2, layout: state.layout, layoutMode: state.layoutMode, activePaneId: state.activePaneId,
    panes: state.panes.map(current => {
      const history = current.history?.filter(pane => !pane.temporary) ?? [];
      const pane = current.temporary ? history.pop() ?? { session: null } : current;
      return { id: current.id, ...serializePaneContent(pane),
        ...(history.length ? { history: history.map(serializePaneContent) } : {}) };
    }) });
}
