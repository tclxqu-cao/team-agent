import { cloneElement, useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { CalendarDays, Columns2, Columns4, Grid2X2, LoaderCircle, LogOut, Maximize2, Minimize2, PanelLeftOpen, Plus, RefreshCw, X } from "lucide-react";
import type { CatalogSession, SessionDashboardSnapshot } from "../../../../core/src/domain/supervision/types";
import type { UnifiedSessionSummary } from "../../global";
import type { ChatViewProps } from "../ChatView";
import ChatHeaderActions from "../ChatHeaderActions";
import { collaborationRequest } from "../collaboration/client";
import { createAgentStore, type AgentStore } from "../../stores/agentStore";
import { equalTaskLayout, resizeTaskSplit, swapTaskPanes, taskPaneIds } from "../../lib/desktop-task-layout";
import { catalogSessionReceipt } from "../../lib/all-sessions";
import { addTaskWorkspaceColumn, addTaskWorkspaceSession, catalogTaskSession, fourColumnTaskWorkspace, isEmptyTaskPane, loadTaskSession, openTaskWorkspaceWebPage, readTaskWorkspace, serializeTaskWorkspace, TASK_PANE_SURFACE_LABELS, taskPaneHistorySeed, updateTaskPaneContent, updateTaskPaneDraft, updateTaskPaneSession, type TaskPane, type TaskPaneDraft, type TaskPaneSurfaceKind, type TaskWorkspaceSnapshot } from "./session-state";
import { TASK_PANE_WEB_LINK_EVENT, type TaskPaneWebLinkRequest } from "../../lib/task-pane-web-links";
import { TASK_PANE_NOTIFICATION_EVENT, type TaskPaneNotificationRequest } from "../../lib/task-pane-notification";
import { closeTaskWorkspacePane, pushTaskPaneNotification } from "./session-state";
import { isWebShell } from "../../web/webLayout";
import TaskSessionPicker from "./TaskSessionPicker";
import TaskSplitLayout from "./TaskSplitLayout";
import TaskPaneConversation from "./TaskPaneConversation";
import TaskPaneChoices from "./TaskPaneChoices";
import TaskPaneSurface from "./TaskPaneSurface";
import TaskPaneWebPage from "./TaskPaneWebPage";
import "./desktop-task-split.css";

interface Props {
  enabled: boolean;
  onOpenCalendar?: () => void;
  children: ReactElement<ChatViewProps>;
  onFocusSession(session: UnifiedSessionSummary): void;
  onNavigateSession(session: UnifiedSessionSummary): void;
  onSessionCreated?(session: UnifiedSessionSummary): void;
  onSplitChange?(open: boolean): void;
}

/** Desktop Electron and wide browser surfaces share one workspace; phones keep the original child. */
export default function DesktopTaskWorkspace({ enabled, children, onFocusSession, onNavigateSession, onSessionCreated, onOpenCalendar, onSplitChange }: Props) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<TaskWorkspaceSnapshot | null>(null);
  const [maximized, setMaximized] = useState<string | null>(null);
  const [picker, setPicker] = useState<string | null>(null);
  const [contentPicker, setContentPicker] = useState<string | null>(null);
  const contentPickerTrigger = useRef<HTMLElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const stores = useRef(new Map<string, AgentStore>());
  const snapshot = useRef(state);
  snapshot.current = state;
  const opened = useRef(open);
  opened.current = open;
  const storageKey = useRef<string | null>(null);
  const operation = useRef(0);
  const hydrating = useRef(false);
  const replacements = useRef(new Map<string, number>());
  const replacementVersion = useRef(0);
  const callbacks = useRef({ onFocusSession, onNavigateSession, onSessionCreated });
  callbacks.current = { onFocusSession, onNavigateSession, onSessionCreated };
  const lastNavigation = useRef(children.props.selectedSessionId);
  const focusNonce = useRef(children.props.focusComposerNonce);
  const source = useRef(children.props);
  source.current = children.props;
  useEffect(() => { onSplitChange?.(enabled && open); }, [enabled, open, onSplitChange]);

  const save = (value: TaskWorkspaceSnapshot | null) => {
    if (!storageKey.current) return;
    try {
      if (value) localStorage.setItem(storageKey.current, serializeTaskWorkspace(value));
      else localStorage.removeItem(storageKey.current);
    } catch { /* Layout remains usable if storage is full. */ }
  };
  useEffect(() => {
    if (!enabled || !open || !state) return;
    const timer = window.setTimeout(() => save(state), 180);
    return () => window.clearTimeout(timer);
  }, [enabled, open, state]);
  useEffect(() => () => { operation.current++; replacements.current.clear(); }, []);
  useEffect(() => {
    if (enabled) return;
    save(snapshot.current);
    operation.current++; replacements.current.clear(); hydrating.current = false;
    opened.current = false; setOpen(false); setLoading(false); setBusy({});
    setPicker(null); setContentPicker(null); setMaximized(null);
  }, [enabled]);
  useEffect(() => {
    if (!contentPicker) return;
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setContentPicker(null); return; }
      if (event.key !== "Tab") return;
      const items = Array.from(document.querySelectorAll<HTMLButtonElement>(".task-content-picker button:not(:disabled)"));
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("keydown", keys);
      if (contentPickerTrigger.current?.isConnected) contentPickerTrigger.current.focus({ preventScroll: true });
    };
  }, [contentPicker]);
  useEffect(() => {
    if (!enabled || !open) return;
    const receive = (event: Event) => {
      if (event.defaultPrevented || hydrating.current || !opened.current || !snapshot.current
        || (!isWebShell() && !window.agentApi?.taskPageOpen)) return;
      const url = (event as CustomEvent<TaskPaneWebLinkRequest>).detail?.url;
      if (typeof url !== "string") return;
      const next = openTaskWorkspaceWebPage(snapshot.current, url);
      if (!next) return;
      event.preventDefault();
      replacements.current.delete(next.activePaneId);
      stores.current.delete(next.activePaneId);
      setBusy(value => ({ ...value, [next.activePaneId]: false }));
      snapshot.current = next; setState(next); setMaximized(null);
    };
    window.addEventListener(TASK_PANE_WEB_LINK_EVENT, receive);
    return () => window.removeEventListener(TASK_PANE_WEB_LINK_EVENT, receive);
  }, [enabled, open]);

  const focusPane = useCallback((id: string) => {
    const current = snapshot.current;
    const pane = current?.panes.find(item => item.id === id);
    if (!current || !pane || current.activePaneId === id) return;
    const next = { ...current, activePaneId: id };
    snapshot.current = next; setState(next);
    setMaximized(current => current ? id : null);
    if (pane.session) {
      lastNavigation.current = pane.session.id;
      callbacks.current.onFocusSession(pane.session);
    }
  }, []);

  const setPaneSession = (paneId: string, session: UnifiedSessionSummary, initialHistory?: TaskPane["initialHistory"]) => {
    const current = snapshot.current;
    if (!current || !current.panes.some(pane => pane.id === paneId)) return;
    const existing = current.panes.find(pane => pane.session?.id === session.id && pane.id !== paneId);
    if (existing) { focusPane(existing.id); return; }
    const next = updateTaskPaneSession(current, paneId, session, initialHistory);
    snapshot.current = next; setState(next);
    if (current.activePaneId === paneId) {
      lastNavigation.current = session.id;
      callbacks.current.onFocusSession(session);
    }
  };

  const replacePane = async (paneId: string, target: { id: string; agentType?: UnifiedSessionSummary["agentType"] }, receipt?: UnifiedSessionSummary) => {
    if (!opened.current || hydrating.current) return;
    const version = ++replacementVersion.current;
    replacements.current.set(paneId, version);
    if (receipt) { setBusy(current => ({ ...current, [paneId]: false })); setPaneSession(paneId, receipt); return; }
    setBusy(current => ({ ...current, [paneId]: true }));
    setError(null);
    try {
      const result = await loadTaskSession(target);
      if (replacements.current.get(paneId) !== version || !opened.current || !result.session) return;
      setPaneSession(paneId, result.session, result.initialHistory);
    } catch (failure) {
      if (opened.current && replacements.current.get(paneId) === version) setError(failure instanceof Error ? failure.message : "无法更换任务");
    } finally {
      if (replacements.current.get(paneId) === version) setBusy(current => ({ ...current, [paneId]: false }));
    }
  };

  useEffect(() => {
    if (!enabled || !open) return;
    const receive = (event: Event) => {
      const sessionId = (event as CustomEvent<TaskPaneNotificationRequest>).detail?.sessionId;
      const current = snapshot.current;
      if (event.defaultPrevented || !sessionId || !current || hydrating.current || !opened.current) return;
      event.preventDefault();
      const paneId = current.activePaneId;
      const version = ++replacementVersion.current;
      replacements.current.set(paneId, version);
      setBusy(value => ({ ...value, [paneId]: true }));
      setError(null);
      void loadTaskSession({ id: sessionId }).then(result => {
        if (!opened.current || replacements.current.get(paneId) !== version || !result.session || !snapshot.current) return;
        const next = pushTaskPaneNotification(snapshot.current, paneId, result.session, result.initialHistory);
        snapshot.current = next; setState(next);
        if (next.activePaneId === paneId) {
          lastNavigation.current = result.session.id;
          callbacks.current.onFocusSession(result.session);
        }
      }).catch(failure => {
        if (opened.current && replacements.current.get(paneId) === version) setError(failure instanceof Error ? failure.message : "无法打开通知会话");
      }).finally(() => {
        if (replacements.current.get(paneId) === version) setBusy(value => ({ ...value, [paneId]: false }));
      });
    };
    window.addEventListener(TASK_PANE_NOTIFICATION_EVENT, receive);
    return () => window.removeEventListener(TASK_PANE_NOTIFICATION_EVENT, receive);
  }, [enabled, open]);

  const initialize = async (reload = false) => {
    const token = ++operation.current;
    hydrating.current = true;
    setPicker(null); setContentPicker(null);
    replacements.current.clear(); setBusy({});
    opened.current = true; setOpen(true); setLoading(true); setError(null); setMaximized(null);
    lastNavigation.current = source.current.selectedSessionId;
    try {
      if (isWebShell()) {
        storageKey.current = `agentroam:web-task-split:v1:${window.location.origin}${window.location.pathname}`;
      } else {
        const service = await window.sharedServiceApi.status();
        const identity = service.selected?.dataDir ?? service.selected?.instanceId;
        if (!identity) throw new Error("请先连接 AgentRoam 服务");
        storageKey.current = `agentroam:desktop-task-split:v1:${identity}`;
      }
      let restored: TaskWorkspaceSnapshot | null = reload ? null : snapshot.current;
      if (!reload && !restored) {
        try { restored = readTaskWorkspace(JSON.parse(localStorage.getItem(storageKey.current) || "null")); } catch { /* Use fresh running tasks for invalid saved state. */ }
      }
      if (!restored) {
        const dashboard = await collaborationRequest<SessionDashboardSnapshot>({ action: "dashboard" });
        if (dashboard.discoveryError) throw new Error(dashboard.discoveryError);
        const running = [...new Map(dashboard.agents.flatMap(agent => agent.sessions)
          .filter(session => session.status !== "completed" && session.status !== "failed")
          .map(session => [session.id, catalogTaskSession(session)])).values()];
        const current = source.current.sessionSummary;
        if (!running.length && current) running.push(current);
        const panes: TaskPane[] = running.map(session => ({ id: crypto.randomUUID(), session }));
        while (panes.length < 2) panes.push({ id: crypto.randomUUID(), session: null });
        restored = { panes, layout: equalTaskLayout(panes.map(pane => pane.id))!, activePaneId: panes.find(pane => pane.session?.id === current?.id)?.id ?? panes[0].id };
      }
      const results = await Promise.allSettled(restored.panes.map(async pane => pane.session
        ? { ...pane, ...await loadTaskSession(pane.session) } : pane));
      if (token !== operation.current || !opened.current) return;
      let failed = 0;
      const panes = results.map((result, index) => {
        if (result.status === "fulfilled") return result.value;
        failed++;
        return restored!.panes[index];
      });
      const next = { ...restored, panes };
      snapshot.current = next;
      setState(next);
      const active = panes.find(pane => pane.id === next.activePaneId)?.session;
      if (active) callbacks.current.onFocusSession(active);
      if (failed) setError(`${failed} 个任务暂未加载完成，可在对应格重试或更换任务`);
    } catch (failure) {
      if (token === operation.current && opened.current) setError(failure instanceof Error ? failure.message : "无法打开任务分屏");
    } finally {
      if (token === operation.current && opened.current) { hydrating.current = false; setLoading(false); }
    }
  };

  const exit = () => {
    save(snapshot.current);
    operation.current++;
    hydrating.current = false;
    replacements.current.clear(); setBusy({}); setLoading(false);
    opened.current = false; setOpen(false); setPicker(null); setContentPicker(null); setMaximized(null);
    const active = snapshot.current?.panes.find(pane => pane.id === snapshot.current?.activePaneId)?.session;
    if (active) callbacks.current.onNavigateSession(active);
  };

  // Existing sidebar navigation replaces the active pane. Focusing another pane
  // updates the parent selection too, so repeated clicks on the same task work.
  useEffect(() => {
    if (!enabled || !open || loading) return;
    const id = children.props.selectedSessionId;
    const session = children.props.sessionSummary;
    if (!id || id === lastNavigation.current || session?.id !== id || !snapshot.current) return;
    lastNavigation.current = id;
    const existing = snapshot.current.panes.find(pane => pane.session?.id === id);
    if (existing) focusPane(existing.id);
    else void replacePane(snapshot.current.activePaneId, session, session);
  }, [enabled, open, loading, children.props.selectedSessionId, children.props.sessionSummary, focusPane]);
  useEffect(() => {
    if (focusNonce.current === children.props.focusComposerNonce) return;
    focusNonce.current = children.props.focusComposerNonce;
    if (open) { save(snapshot.current); operation.current++; replacements.current.clear(); setBusy({}); opened.current = false; setOpen(false); setPicker(null); setContentPicker(null); }
  }, [children.props.focusComposerNonce, open]);

  if (!enabled) return children;

  const choose = async (target: CatalogSession) => {
    const destination = picker;
    setPicker(null);
    if (!open || destination === "single") { callbacks.current.onNavigateSession(catalogTaskSession(target)); return; }
    const current = snapshot.current;
    if (!current || !destination) return;
    const existing = current.panes.find(pane => pane.session?.id === target.id);
    if (existing) { focusPane(existing.id); return; }
    if (destination === "add") {
      const added = addTaskWorkspaceSession(current, catalogTaskSession(target), crypto.randomUUID());
      snapshot.current = added.state; setState(added.state); setMaximized(null);
      await replacePane(added.paneId, target);
    } else await replacePane(destination, target);
  };
  const closePane = (id: string) => {
    const current = snapshot.current;
    if (!current) return;
    const next = closeTaskWorkspacePane(current, id);
    if (next === current) return;
    replacements.current.delete(id);
    setBusy(value => ({ ...value, [id]: false }));
    setPicker(value => value === id ? null : value);
    setContentPicker(value => value === id ? null : value);
    snapshot.current = next; setState(next);
    if (!next || next.layout !== current.layout) {
      stores.current.delete(id);
      setMaximized(value => value === id ? null : value);
    }
    if (!next) { exit(); return; }
    save(next);
    if (current.activePaneId === id) {
      const active = next.panes.find(pane => pane.id === next.activePaneId)?.session;
      if (active) {
        lastNavigation.current = active.id;
        callbacks.current.onFocusSession(active);
      }
    }
  };
  const props = children.props;
  const webShell = isWebShell();
  const embeddedWebShell = webShell && window.parent !== window;
  const activePane = state?.panes.find(pane => pane.id === state.activePaneId);
  const activePaneAgent = activePane?.session?.agentType ?? activePane?.draft?.agentType;
  const changeDraft = (id: string, draft: TaskPaneDraft) => setState(value => value ? updateTaskPaneDraft(value, id, draft) : value);
  const setContent = (id: string, content: { surface: TaskPaneSurfaceKind } | { webUrl: string } | null) => {
    if (hydrating.current) return;
    if (isWebShell() && content && "surface" in content && content.surface === "remote-desktop") {
      const existing = snapshot.current?.panes.find(pane => pane.id !== id && pane.surface === "remote-desktop");
      if (existing) { setContentPicker(null); focusPane(existing.id); return; }
    }
    replacements.current.delete(id);
    stores.current.delete(id);
    setBusy(value => ({ ...value, [id]: false }));
    const current = snapshot.current;
    if (!current) return;
    const next = updateTaskPaneContent(current, id, content);
    snapshot.current = next; setState(next); setContentPicker(null);
  };
  const openSurface = (kind: TaskPaneSurfaceKind, fallback?: () => void) => {
    if (hydrating.current) return;
    const current = snapshot.current;
    const existing = current?.panes.find(pane => pane.surface === kind);
    if (existing) { focusPane(existing.id); return; }
    const active = current?.panes.find(pane => pane.id === current.activePaneId);
    const empty = active && isEmptyTaskPane(active) ? active : current?.panes.find(isEmptyTaskPane);
    if (empty) setContent(empty.id, { surface: kind });
    else if (fallback) fallback();
    else if (current) {
      const added = addTaskWorkspaceColumn(current, crypto.randomUUID());
      const next = updateTaskPaneContent(added, added.activePaneId, { surface: kind });
      snapshot.current = next; setState(next); setMaximized(null);
    }
  };
  const startDraft = (id: string) => {
    const current = snapshot.current;
    if (hydrating.current || !current) return;
    const props = source.current;
    replacements.current.delete(id);
    stores.current.delete(id);
    setBusy(value => ({ ...value, [id]: false }));
    const next = updateTaskPaneDraft(current, id, { agentType: props.sessionSummary?.agentType ?? props.activeAgentType ?? "customer-agent",
      projectId: props.sessionSummary?.projectId ?? props.selectedProjectId ?? null,
      cwd: props.sessionSummary?.cwd ?? props.workspacePath ?? "", workspaceSource: props.workspaceSource }, true);
    snapshot.current = next; setState(next); setContentPicker(null);
  };
  const renderPane = (id: string) => {
    const pane = state?.panes.find(item => item.id === id);
    if (!pane) return null;
    let store = stores.current.get(id);
    if (!store) { store = createAgentStore(); stores.current.set(id, store); }
    const session = pane.session;
    const draft = pane.draft;
    const label = pane.surface ? TASK_PANE_SURFACE_LABELS[pane.surface] : pane.webUrl ? "网页" : session?.title || (draft ? "新建会话" : "空面板");
    const paneControls = <div className="task-pane-controls">
      <button type="button" className="ui-icon-button" onClick={event => { contentPickerTrigger.current = event.currentTarget; setContentPicker(id); }} title="切换面板内容" aria-label="切换面板内容"><Grid2X2 size={15} /></button>
      <button type="button" className="ui-icon-button" onClick={() => setMaximized(value => value === id ? null : id)} title={maximized === id ? "恢复分屏" : "放大此格"} aria-label={maximized === id ? "恢复分屏" : "放大此格"}>{maximized === id ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      <button type="button" className="ui-icon-button" onClick={() => closePane(id)}
        title={pane.history?.length ? "关闭当前内容，返回上一项" : "移除此格（任务继续运行）"}
        aria-label={pane.history?.length ? "关闭当前内容，返回上一项" : "移除此格"}><X size={16} /></button>
    </div>;
    return <section className={`task-pane${state?.activePaneId === id ? " is-active" : ""}${maximized === id ? " is-maximized" : ""}`} key={id}
      data-task-pane={id} data-task-session={session?.id ?? ""} data-pane-content={pane.surface ?? (pane.webUrl ? "web" : session || draft ? "task" : "empty")} aria-label={label}
      onPointerDownCapture={() => focusPane(id)} onFocusCapture={() => focusPane(id)}>
      {pane.surface || pane.webUrl ? <div className="task-pane-feature">
        <header className="chat-top-bar task-pane-feature-header"><strong>{label}</strong>{paneControls}</header>
        {pane.surface ? <TaskPaneSurface kind={pane.surface} cwd={props.workspacePath ?? undefined} active={!maximized || maximized === id}
          onOpenSession={target => { void replacePane(id, target); }}
          onNewSession={() => startDraft(id)} onChangeContent={() => setContentPicker(id)}
          onViewAgent={() => setPicker(id)}
          onSelectSurface={kind => setContent(id, { surface: kind })} />
          : <TaskPaneWebPage paneId={id} url={pane.webUrl!} visible={!maximized || maximized === id} onFocus={() => focusPane(id)} />}
      </div> : session || draft ? <TaskPaneConversation draft={draft} onDraftChange={value => changeDraft(id, value)}>{cloneElement(children, {
        agentStore: store, desktopTaskPane: true,
        desktopTaskOwnsSession: sessionId => {
          if (!opened.current) return false;
          const panes = snapshot.current?.panes ?? [];
          return panes.some(item => item.id === id && item.session?.id === sessionId)
            || !panes.some(item => item.session?.id === sessionId);
        },
        activeAgentType: session?.agentType ?? draft!.agentType, selectedProjectId: session?.projectId ?? draft?.projectId ?? null,
        selectedSessionId: session?.id ?? null, sessionSummary: session ?? undefined, sessionTitle: session?.title ?? "新建会话",
        workspacePath: session?.cwd ?? draft!.cwd, workspaceSource: undefined,
        initialSessionHistory: taskPaneHistorySeed(pane, props.initialSessionHistory),
        onToggleSidebar: undefined, onReplaceTask: () => setPicker(id), paneControls,
        headerAppActions: undefined, onOpenTaskSplit: undefined,
        onSelectAgent: undefined, onSelectWorkspace: undefined, onPickWorkspaceFolder: undefined,
        voiceCommand: state?.activePaneId === id ? props.voiceCommand : null,
        focusComposerNonce: draft ? 1 : undefined,
        onSelectSession: (sessionId, summary) => { void replacePane(id, { id: sessionId }, summary); },
        onSessionCreated: (sessionId, receipt) => {
          void replacePane(id, { id: sessionId }, receipt);
          if (receipt) callbacks.current.onSessionCreated?.(receipt);
        },
        onParallelSessionSelected: receipt => { void replacePane(id, receipt, receipt); },
      })}</TaskPaneConversation> : <div className="task-pane-empty"><div className="task-pane-empty-controls">{paneControls}</div><Columns2 size={24} aria-hidden="true" /><p>选择这一列要展示的内容</p><TaskPaneChoices onTask={() => setPicker(id)} onDraft={() => startDraft(id)} onSurface={kind => setContent(id, { surface: kind })} /><small>消息中的网页链接也会在空面板中打开</small></div>}
      {busy[id] && <div className="task-pane-loading" role="status"><LoaderCircle size={20} className="task-split-spinner" />正在更换任务…</div>}
    </section>;
  };

  return <>
    {!open ? cloneElement(children, { onOpenTaskSplit: () => { void initialize(); }, onReplaceTask: () => setPicker("single") }) : <div className="desktop-task-workspace">
      <header className="task-workspace-toolbar">
        {props.onToggleSidebar && <button className="ui-icon-button" type="button" onClick={props.onToggleSidebar} aria-label="切换任务侧栏"><PanelLeftOpen size={17} /></button>}
        <span className="task-workspace-label"><Columns2 size={16} />任务分屏{state ? <small>{state.panes.length}</small> : null}</span>
        <div className="task-workspace-tools">
          {onOpenCalendar && <button type="button" onClick={() => openSurface("calendar", onOpenCalendar)} title="日历与待办" aria-label="打开日历与待办"><CalendarDays size={16} aria-hidden="true" /><span>日历 / 待办</span></button>}
          <button type="button" onClick={() => setPicker("add")} disabled={loading || !state} title="添加任务" aria-label="添加分屏任务"><Plus size={16} /><span>添加任务</span></button>
          <button type="button" onClick={() => { setMaximized(null); setState(value => value ? addTaskWorkspaceColumn(value, crypto.randomUUID()) : value); }} disabled={loading || !state} title="在最右侧新增一列，保留现有布局比例" aria-label="新增一列"><Columns2 size={16} /><span>新增一列</span></button>
          <button type="button" onClick={() => { setMaximized(null); setState(value => value ? fourColumnTaskWorkspace(value, () => crypto.randomUUID()) : value); }} disabled={loading || !state} title="四列布局，空位会保留给新任务" aria-label="四列布局" aria-pressed={state?.layoutMode === "four-columns"}><Columns4 size={16} /><span>四列</span></button>
          <button type="button" onClick={() => { setMaximized(null); setState(value => value ? { ...value, layoutMode: undefined, layout: equalTaskLayout(value.panes.map(pane => pane.id))! } : value); }} disabled={loading || !state} title="重新等分" aria-label="重新等分任务"><Grid2X2 size={16} /></button>
          <button type="button" onClick={() => { void initialize(true); }} disabled={loading} title="重新载入进行中任务" aria-label="重新载入进行中任务"><RefreshCw size={16} className={loading ? "task-split-spinner" : undefined} /></button>
          <button type="button" onClick={exit} title="退出任务分屏" aria-label="退出任务分屏"><LogOut size={16} aria-hidden="true" /><span>退出分屏</span></button>
        </div>
        {props.onOpenSettings && props.onHideToBackground && props.onToggleAppearance && <ChatHeaderActions
          appActions={props.headerAppActions} appearanceOpen={Boolean(props.appearanceOpen)} settingsOpen={Boolean(props.settingsOpen)}
          showSettings={!webShell || activePaneAgent === "customer-agent"}
          onHideToBackground={props.onHideToBackground} onToggleAppearance={props.onToggleAppearance} onOpenSettings={props.onOpenSettings}
          onOpenSessionDashboard={embeddedWebShell ? undefined : () => openSurface("dashboard", props.onOpenSessionDashboard)}
          onOpenCollaborationDashboard={embeddedWebShell ? undefined : () => openSurface("groups", props.onOpenCollaborationDashboard)}
          onOpenDesktopLive={embeddedWebShell ? undefined : () => openSurface("remote-desktop", props.onOpenDesktopLive)} desktopLiveOpen={props.desktopLiveOpen}
          onToggleFiles={props.onToggleFiles} filesOpen={props.fileDrawerOpen} onOpenHub={props.onOpenHub}
        />}
      </header>
      {error && <div className="task-workspace-error" role="alert"><span>{error}</span><button type="button" onClick={() => { void initialize(); }}>重试</button></div>}
      <div className="task-workspace-layout">
        {loading && !state ? <div className="task-workspace-loading" role="status"><LoaderCircle className="task-split-spinner" size={22} />正在载入任务分屏…</div>
          : state ? <div className={`task-workspace-tree${maximized ? " has-maximized-task" : ""}`} data-maximized-pane={maximized ?? undefined}
            ref={element => { if (element) element.inert = loading; }} aria-hidden={loading || undefined}>
            <TaskSplitLayout node={state.layout} renderPane={renderPane} maximizedPaneId={maximized}
              onResize={(id, ratio) => setState(value => value ? { ...value, layout: resizeTaskSplit(value.layout, id, ratio) } : value)}
              onSwap={(source, target) => setState(value => {
                if (!value) return value;
                const layout = swapTaskPanes(value.layout, source, target);
                if (layout === value.layout) return value;
                const byId = new Map(value.panes.map(pane => [pane.id, pane]));
                return { ...value, layout, panes: taskPaneIds(layout).map(id => byId.get(id)!) };
              })} />
          </div> : null}
        {loading && state && <div className="task-workspace-loading task-workspace-loading--overlay" role="status"><LoaderCircle className="task-split-spinner" size={22} />正在重新载入…</div>}
      </div>
    </div>}
    {picker && <TaskSessionPicker currentId={picker === "single" ? props.selectedSessionId ?? undefined : state?.panes.find(pane => pane.id === picker)?.session?.id}
      openIds={new Set(open ? state?.panes.flatMap(pane => pane.session ? [pane.session.id] : []) ?? [] : [])}
      knownSessions={[...(props.sessionSummary ? [props.sessionSummary] : []), ...(state?.panes.flatMap(pane => pane.session ? [pane.session] : []) ?? [])].map(catalogSessionReceipt)}
      onChoose={target => { void choose(target); }} onClose={() => setPicker(null)} />}
    {open && contentPicker && createPortal(<div className="task-picker-backdrop" onClick={event => { if (event.target === event.currentTarget) setContentPicker(null); }}>
      <section className="task-picker task-content-picker" role="dialog" aria-modal="true" aria-label="选择面板内容" onKeyDown={event => { if (event.key === "Escape") setContentPicker(null); }}>
        <header><h2>选择面板内容</h2><button type="button" className="ui-icon-button" aria-label="关闭内容选择" autoFocus onClick={() => setContentPicker(null)}><X size={18} /></button></header>
        <TaskPaneChoices onTask={() => { setPicker(contentPicker); setContentPicker(null); }} onDraft={() => startDraft(contentPicker)} onSurface={kind => setContent(contentPicker, { surface: kind })} />
        <button type="button" className="task-pane-clear" onClick={() => setContent(contentPicker, null)}>清空此面板</button>
      </section>
    </div>, document.body)}
  </>;
}
