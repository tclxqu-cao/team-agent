import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { History, LoaderCircle, Plus, Search } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import ChatView from "./components/ChatView";
import AIHubView from "./components/AIHubView";
import UpdateNotice from "./components/UpdateNotice";
import DesktopLiveControlBanner from "./components/DesktopLiveControlBanner";
import { renewVoiceConversation } from "./lib/voice-command";
import {
  getSidebarSessionVisualState,
  SIDEBAR_SESSION_STATUS_LABELS,
} from "./lib/sidebar-session-status";
import {
  orderSessionsForAgent,
  sortNewestSessionsFirst,
  sortPinnedSessionsFirst,
  sortRunningSessionsFirst,
} from "./lib/sidebar-session-sort";
import {
  EMPTY_SIDEBAR_SELECTION,
  selectProject,
  selectSession,
  type SidebarSelection,
} from "./lib/sidebar-selection";
import {
  removeSessionIdsFromWorkspacePartition,
  removeSessionFromCollections,
  sessionDeletionConfirmation,
} from "./lib/session-deletion";
import SettingsPanel from "./components/SettingsPanel";
import DesktopLiveDialog from "./components/DesktopLiveDialog";
import MCPServerList from "./components/MCPServerList";
import MemoryViewer from "./components/MemoryViewer";
import SkillManager from "./components/SkillManager";
import AgentManager from "./components/AgentManager";
import LSPServerList from "./components/LSPServerList";
import WakeOverlay from "./components/WakeOverlay";
import AgentWorkspaceSwitcher from "./components/AgentWorkspaceSwitcher";
import AgentBrandIcon from "./components/AgentBrandIcon";
import SidebarDeleteConfirmation from "./components/SidebarDeleteConfirmation";
import SidebarSessionRow, { type SidebarDeleteAnchor } from "./components/SidebarSessionRow";
import HostProjectPicker from "./components/HostProjectPicker";
import type {
  AgentType,
  AgentWorkspace,
  ImportAgentWorkspaceResult,
  RuntimeHealth,
  WorkspacePage,
} from "./global";
import {
  emptyAgentWorkspacePartition,
  preservePendingNativeSession,
  readAgentWorkspaceCache,
  reconcileSessionPage,
  reconcileWorkspacePage,
  writeAgentWorkspaceCache,
  type AgentWorkspaceCache,
} from "./lib/agent-workspace-cache";
import { useSettingsStore } from "./stores/settingsStore";
import { useAgentStore } from "./stores/agentStore";
import { useUIStore, SKINS, LAYOUTS } from "./stores/uiStore";
import { startWakeListener, isASRSupported, type WakeListenerHandle } from "./lib/speech";
import { isWebShell, useNarrowViewport } from "./web/webLayout";

type SettingsTab = "settings" | "mcp" | "memory" | "skill" | "agent" | "lsp";

interface Project {
  id: string;
  name: string;
  description: string;
  created: string;
  updated: string;
  agentType?: AgentType;
  source?: AgentWorkspace["source"];
  canCreateSession?: boolean;
}

interface Session {
  id: string;
  projectId?: string;
  parentSessionId?: string;
  agentType: AgentType;
  nativeSessionId: string;
  title: string;
  status: string;
  occupancy: "available" | "owned-by-customer-agent" | "owned-externally";
  sourceLabel: string;
  canResume: boolean;
  canDelete: boolean;
  cwd: string;
  created: string;
  updated: string;
  compatibility?: import("./global").SessionCompatibility;
  migratedFrom?: string;
}

function buildCachedSessionState(
  cache: Record<string, { data: Session[]; loaded: boolean }>,
  agentType: AgentType,
) {
  const roots: Record<string, Session[]> = {};
  const children: Record<string, Session[]> = {};
  for (const [projectId, entry] of Object.entries(cache)) {
    const sessions = entry.data;
    roots[projectId] = orderSessionsForAgent(
      sessions.filter((session) => !session.parentSessionId),
      agentType,
    );
    for (const child of sessions.filter((session) => session.parentSessionId)) {
      (children[child.parentSessionId!] ??= []).push(child);
    }
  }
  for (const group of Object.values(children)) {
    group.sort((left, right) => left.created.localeCompare(right.created));
  }
  return {
    roots,
    children,
    projectIds: new Set(Object.entries(cache).filter(([, entry]) => entry.loaded).map(([id]) => id)),
  };
}

function shouldRefreshWorkspaceSessions(
  agentType: AgentType,
  project: Pick<Project, "canCreateSession"> | undefined,
  hasCache: boolean,
): boolean {
  return agentType === "codex" && project?.canCreateSession !== false ? true : hasCache;
}

function workspaceToProject(workspace: AgentWorkspace): Project {
  return {
    id: workspace.workspaceId,
    name: workspace.name,
    description: workspace.roots[0] ?? "",
    created: workspace.updatedAt ?? "",
    updated: workspace.updatedAt ?? "",
    agentType: workspace.agentType,
    source: workspace.source,
    canCreateSession: workspace.canCreateSession,
  };
}

function SidebarDeleteIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M8 6V4h8v2" />
      <path d="M19 6l-1 14H6L5 6" />
      <path d="M10 11v5M14 11v5" />
    </svg>
  );
}

function blurDeactivatedPointerToggle(
  event: React.MouseEvent<HTMLButtonElement>,
  wasActive: boolean,
): void {
  if (wasActive && event.detail > 0) event.currentTarget.blur();
}

function blurActiveTextEntry(): void {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLElement
    && (activeElement.matches("input, textarea, select") || activeElement.isContentEditable)
  ) {
    activeElement.blur();
  }
}

export default function App() {
  const [initialWorkspaceCache] = useState(readAgentWorkspaceCache);
  const initialAgent = initialWorkspaceCache.activeAgent;
  const initialPartition = initialWorkspaceCache.agents[initialAgent] ?? emptyAgentWorkspacePartition();
  const [initialSessionState] = useState(() => buildCachedSessionState(
    initialPartition.sessions as Record<string, { data: Session[]; loaded: boolean }>,
    initialAgent,
  ));
  const workspaceCacheRef = useRef<AgentWorkspaceCache>(initialWorkspaceCache);
  const [activeAgent, setActiveAgent] = useState<AgentType>(initialAgent);
  const activeAgentRef = useRef(activeAgent);
  activeAgentRef.current = activeAgent;
  const [projects, setProjects] = useState<Project[]>(
    initialPartition.workspaces.map(workspaceToProject),
  );
  const [workspaceNextCursor, setWorkspaceNextCursor] = useState<string | null>(initialPartition.nextCursor);
  const [workspaceWatermark, setWorkspaceWatermark] = useState<string | null>(initialPartition.watermark);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workspaceStale, setWorkspaceStale] = useState(false);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [hostProjectPickerOpen, setHostProjectPickerOpen] = useState(false);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>(initialSessionState.roots);
  const [sessionQuery, setSessionQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchListLimit, setSearchListLimit] = useState(10);
  const [sessionDeleteRequest, setSessionDeleteRequest] = useState<{
    session: Session;
    anchor: SidebarDeleteAnchor;
  } | null>(null);
  const [sessionDeletePending, setSessionDeletePending] = useState(false);
  const [invalidWorkspaceDeleteRequest, setInvalidWorkspaceDeleteRequest] = useState<{
    project: Project;
    anchor: SidebarDeleteAnchor;
  } | null>(null);
  const [invalidWorkspaceDeletePending, setInvalidWorkspaceDeletePending] = useState(false);
  const [sessionCreationPending, setSessionCreationPending] = useState<{
    projectId: string;
    agentType: AgentType;
  } | null>(null);
  const sessionCreationPendingRef = useRef(false);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth[]>([]);
  /** Child sessions keyed by parentSessionId */
  const [childSessionsByParent, setChildSessionsByParent] = useState<Record<string, Session[]>>(initialSessionState.children);
  const sessionsByProjectRef = useRef(sessionsByProject);
  const childSessionsByParentRef = useRef(childSessionsByParent);
  sessionsByProjectRef.current = sessionsByProject;
  childSessionsByParentRef.current = childSessionsByParent;
  /** Projects whose sessions have completed at least one successful load. */
  const [loadedProjectIds, setLoadedProjectIds] = useState<Set<string>>(initialSessionState.projectIds);
  const [loadingProjectIds, setLoadingProjectIds] = useState<Set<string>>(new Set());
  const [projectSessionErrors, setProjectSessionErrors] = useState<Record<string, string>>({});
  const [staleProjectIds, setStaleProjectIds] = useState<Set<string>>(new Set());
  const [sessionNextCursors, setSessionNextCursors] = useState<Record<string, string | null>>(
    Object.fromEntries(Object.entries(initialPartition.sessions).map(([id, entry]) => [id, entry.nextCursor])),
  );
  const projectSessionRequestIds = useRef(new Map<string, number>());
  const workspaceRequestIds = useRef(new Map<AgentType, number>());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialPartition.selectedWorkspaceId);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(initialPartition.selectedSessionId);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedProjectIdRef.current = selectedProjectId;
  selectedSessionIdRef.current = selectedSessionId;
  /** Set of parent session IDs whose children are collapsed */
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  /** Set of project IDs whose session list is expanded */
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(initialPartition.expandedWorkspaceIds),
  );
  /** Project IDs whose working directory path no longer exists on disk */
  const [invalidProjectIds, setInvalidProjectIds] = useState<Set<string>>(new Set());

  const [showSettings, setShowSettings] = useState(false);
  const [showDesktopLive, setShowDesktopLive] = useState(false);
  // AI Hub（多 AI 网页聚合）：打开时内容区切换为 AIHubView，ChatView 保持挂载仅隐藏
  const [hubOpen, setHubOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("settings");

  const setTodos = useAgentStore((s) => s.setTodos);

  // ── Appearance & voice preferences ─────────────────────────────────────
  const skin = useUIStore((s) => s.skin);
  const layout = useUIStore((s) => s.layout);
  const wakeEnabled = useUIStore((s) => s.wakeEnabled);
  const wakeWord = useUIStore((s) => s.wakeWord);
  const setSkin = useUIStore((s) => s.setSkin);
  const setLayout = useUIStore((s) => s.setLayout);
  const setWakeEnabled = useUIStore((s) => s.setWakeEnabled);
  const setWakeWord = useUIStore((s) => s.setWakeWord);
  const autoSpeak = useUIStore((s) => s.autoSpeak);
  const setAutoSpeak = useUIStore((s) => s.setAutoSpeak);
  const runningFirst = useUIStore((s) => s.runningFirst);
  const setRunningFirst = useUIStore((s) => s.setRunningFirst);
  const pinnedSessionIds = useUIStore((s) => s.pinnedSessionIds);
  const togglePinnedSession = useUIStore((s) => s.togglePinnedSession);
  const removePinnedSessions = useUIStore((s) => s.removePinnedSessions);
  const pinnedSessionIdSet = new Set(pinnedSessionIds);
  const runningSessionId = useAgentStore((s) => s.runningSessionId);
  const sessionsNeedingInput = useAgentStore(useShallow((s) =>
    Object.entries(s.messagesBySession)
      .filter(([, messages]) => messages.some((message) => message.askUser && !message.askUser.answered))
      .map(([sessionId]) => sessionId),
  ));

  const isSessionRunning = useCallback(
    (session: Session) => session.status === "running" || runningSessionId === session.id,
    [runningSessionId],
  );

  /** Collapse every project and nested session group in the sidebar. */
  const handleCollapseAllSessions = () => {
    setExpandedProjects(new Set());
    setCollapsedParents(new Set(Object.keys(childSessionsByParent)));
  };
  /** Expand every valid project and nested session group in the sidebar. */
  const handleExpandAllSessions = () => {
    const expandableProjects = projects.filter((project) => !invalidProjectIds.has(project.id));
    const projectIds = expandableProjects.map((project) => project.id);
    setExpandedProjects(new Set(projectIds));
    setCollapsedParents(new Set());
    for (const project of expandableProjects) {
      const projectId = project.id;
      if (loadingProjectIdsRef.current.has(projectId)) continue;
      const hasCache = loadedProjectIdsRef.current.has(projectId);
      const shouldRefresh = shouldRefreshWorkspaceSessions(
        activeAgentRef.current,
        project,
        hasCache,
      );
      void loadSessions(projectId, { refresh: shouldRefresh, background: hasCache });
    }
  };
  // ── Web shell (packages/webapp): drawer sidebar on phone-width screens ──
  // Gated on the web-shell flag so the Electron app keeps its exact layout.
  const webShell = isWebShell();
  const narrowViewport = useNarrowViewport();
  const mobileDrawer = webShell && narrowViewport;
  const [sidebarDrawerOpen, setSidebarDrawerOpen] = useState(false);

  const [showAppearance, setShowAppearance] = useState(false);
  const [appearanceAnchor, setAppearanceAnchor] = useState<{ right: number; bottom: number } | null>(null);
  const [wakeTrigger, setWakeTrigger] = useState(0);
  const [wakeHeard, setWakeHeard] = useState<string | undefined>(undefined);
  const wakeHandleRef = useRef<WakeListenerHandle | null>(null);
  const wakeNativeActive = useRef(false);
  /** Voice command captured after the wake word (text + routed project) */
  const [voiceCommand, setVoiceCommand] = useState<{ text: string; projectId: string | null; sessionId?: string | null; nonce: number } | null>(null);
  /** Active two-way voice conversation: follow-up voice commands route to
   *  this session instead of creating a new one. */
  const convoRef = useRef<{ sessionId: string; until: number } | null>(null);
  /** Set while a voice command awaits session creation (arms conversation) */
  const pendingVoiceConvo = useRef(false);
  // Refs so the wake-command subscription (registered once) sees fresh state
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const invalidProjectsRef = useRef(invalidProjectIds);
  invalidProjectsRef.current = invalidProjectIds;
  const loadedProjectIdsRef = useRef(loadedProjectIds);
  loadedProjectIdsRef.current = loadedProjectIds;
  const loadingProjectIdsRef = useRef(loadingProjectIds);
  loadingProjectIdsRef.current = loadingProjectIds;
  const sidebarScrollRef = useRef<HTMLDivElement | null>(null);

  // Apply skin / layout to the DOM
  useEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
  }, [skin]);
  useEffect(() => {
    document.body.classList.toggle("layout-compact", layout === "compact");
  }, [layout]);
  useEffect(() => {
    const workspaces: AgentWorkspace[] = projects.map((project, order) => ({
      agentType: activeAgent,
      workspaceId: project.id,
      name: project.name,
      roots: project.description ? [project.description] : [],
      order,
      updatedAt: project.updated || undefined,
      source: project.source ?? (project.agentType === "claude-code" ? "derived" : "native"),
      canCreateSession: project.canCreateSession,
    }));
    const sessions = Object.fromEntries(projects.map((project) => [project.id, {
      data: [
        ...(sessionsByProject[project.id] ?? []),
        ...Object.values(childSessionsByParent).flat().filter((session) => (
          (sessionsByProject[project.id] ?? []).some((root) => root.id === session.parentSessionId)
        )),
      ],
      nextCursor: sessionNextCursors[project.id] ?? null,
      loaded: loadedProjectIds.has(project.id),
    }]));
    const cache: AgentWorkspaceCache = {
      ...workspaceCacheRef.current,
      version: 2,
      activeAgent,
      agents: {
        ...workspaceCacheRef.current.agents,
        [activeAgent]: {
          workspaces,
          nextCursor: workspaceNextCursor,
          watermark: workspaceWatermark,
          expandedWorkspaceIds: [...expandedProjects],
          selectedWorkspaceId: selectedProjectId,
          selectedSessionId,
          sidebarScrollTop: sidebarScrollRef.current?.scrollTop ?? 0,
          sessions,
        },
      },
    };
    workspaceCacheRef.current = cache;
    writeAgentWorkspaceCache(cache);
  }, [
    activeAgent,
    childSessionsByParent,
    expandedProjects,
    loadedProjectIds,
    projects,
    selectedProjectId,
    selectedSessionId,
    sessionNextCursors,
    sessionsByProject,
    workspaceNextCursor,
    workspaceWatermark,
  ]);

  const beginWakeListening = useCallback(() => {
    if (!window.agentApi || !wakeEnabled) return;
    if (wakeNativeActive.current || wakeHandleRef.current) return;
    const startWebFallback = () => {
      if (isASRSupported() && !wakeHandleRef.current) {
        wakeHandleRef.current = startWakeListener({
          wakeWord,
          onWake: (heard) => {
            setWakeHeard(heard);
            setWakeTrigger((t) => t + 1);
            void window.agentApi?.showWindow();
          },
          onError: (msg) => console.warn("[wake]", msg),
        });
      }
    };
    // Prefer the native macOS Speech listener — it does not depend on
    // Google's speech services, which are unreachable from CN networks.
    if (typeof window.agentApi.wakeStart === "function") {
      wakeNativeActive.current = true;
      void window.agentApi
        .wakeStart(wakeWord)
        .then((res) => {
          if (!res.ok) {
            wakeNativeActive.current = false;
            startWebFallback();
          }
        })
        .catch(() => {
          wakeNativeActive.current = false;
          startWebFallback();
        });
    } else {
      startWebFallback();
    }
  }, [wakeEnabled, wakeWord]);

  // Native wake fires from the main process (main shows the window itself);
  // here we only play the wake animation.
  useEffect(() => {
    if (!window.agentApi?.onWake) return;
    return window.agentApi.onWake((heard) => {
      wakeNativeActive.current = false;
      setWakeHeard(heard);
      setWakeTrigger((t) => t + 1);
    });
  }, []);

  // 全局唤醒快捷键：主进程已把窗口带到前台，这里只展示 AI Hub 页（focus 布局隐藏侧边栏）
  useEffect(() => {
    if (!window.agentApi?.onWakeAiHub) return;
    return window.agentApi.onWakeAiHub(() => {
      setHubOpen(true);
      setLayout("focus");
    });
  }, []);

  // Voice command captured right after the wake word: route to a project
  // when its name is mentioned in the command, then hand the command to
  // ChatView which creates a session and runs the agent. No project mention
  // → plain session (projects are not a hard dependency).
  useEffect(() => {
    if (!window.agentApi?.onWakeCommand) return;
    return window.agentApi.onWakeCommand((payload) => {
      const text = (payload?.text || "").trim();
      if (!text) return;
      // Two-way conversation: route follow-ups to the existing voice session
      const convo = convoRef.current && Date.now() < convoRef.current.until ? convoRef.current : null;
      if (convo) {
        convo.until = Date.now() + 90000;
        setSelectedSessionId(convo.sessionId);
        void window.agentApi?.wakeConversation(true);
        setVoiceCommand({ text, projectId: null, sessionId: convo.sessionId, nonce: Date.now() });
        setNotice(`语音追问：${text.length > 40 ? text.slice(0, 40) + "…" : text}`);
        setNoticeType("success");
        setTimeout(() => setNotice(null), 4000);
        return;
      }
      const proj = projectsRef.current.find(
        (p) => p.name && text.includes(p.name) && !invalidProjectsRef.current.has(p.id),
      );
      if (proj) {
        setSelectedProjectId(proj.id);
        setExpandedProjects((prev) => { const n = new Set(prev); n.add(proj.id); return n; });
      }
      setSelectedSessionId(null);
      pendingVoiceConvo.current = true;
      // Voice-originated sessions speak their replies back (two-way voice)
      setAutoSpeak(true);
      setVoiceCommand({ text, projectId: proj?.id ?? null, nonce: Date.now() });
      setNotice(`语音指令：${text.length > 40 ? text.slice(0, 40) + "…" : text}${proj ? `（项目：${proj.name}）` : ""}`);
      setNoticeType("success");
      setTimeout(() => setNotice(null), 4000);
    });
  }, []);

  const hideToBackground = useCallback(async () => {
    if (!window.agentApi) return;
    // Start the wake loop before hiding so it never misses the wake word
    beginWakeListening();
    await window.agentApi.hideWindow();
  }, [beginWakeListening]);

  const toggleAppearance = useCallback((anchor: DOMRect) => {
    setShowSettings(false);
    setAppearanceAnchor({ right: anchor.right, bottom: anchor.bottom });
    setShowAppearance((visible) => !visible);
  }, []);

  const toggleSettings = useCallback(() => {
    setShowAppearance(false);
    setShowSettings((visible) => !visible);
  }, []);

  useEffect(() => {
    if (!showAppearance) return;

    const syncAppearanceAnchor = () => {
      const button = document.querySelector<HTMLButtonElement>(".chat-header-action--appearance");
      if (!button) return;
      const rect = button.getBoundingClientRect();
      setAppearanceAnchor((current) => (
        current?.right === rect.right && current.bottom === rect.bottom
          ? current
          : { right: rect.right, bottom: rect.bottom }
      ));
    };

    const frame = window.requestAnimationFrame(syncAppearanceAnchor);
    window.addEventListener("resize", syncAppearanceAnchor);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", syncAppearanceAnchor);
    };
  }, [layout, showAppearance]);

  // Start wake listening as soon as the app loads (not only when hidden):
  // SFSpeechRecognizer needs a long warm-up before it reports anything, so
  // keeping it running while the window is visible makes the later wake
  // reliable. Matches are ignored by the main process while visible.
  useEffect(() => {
    if (!window.agentApi) return;
    beginWakeListening();
  }, [beginWakeListening]);

  // Stop only the web fallback when the window regains focus; the native
  // helper must stay alive to keep the recognizer warm.
  useEffect(() => {
    const onFocus = () => {
      wakeHandleRef.current?.stop();
      wakeHandleRef.current = null;
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Toggle off → stop listening entirely (both native and web fallback)
  useEffect(() => {
    if (wakeEnabled) return;
    wakeHandleRef.current?.stop();
    wakeHandleRef.current = null;
    wakeNativeActive.current = false;
    void window.agentApi?.wakeStop();
  }, [wakeEnabled]);

  // Wake-word edit → push the new word to the already-running native
  // listener (wake:start refreshes the match variants in the main process)
  useEffect(() => {
    if (!wakeEnabled || !window.agentApi) return;
    if (wakeNativeActive.current) void window.agentApi.wakeStart(wakeWord);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wakeWord]);

  useEffect(() => () => {
    wakeHandleRef.current?.stop();
  }, []);

  const allVisibleSessions = [
    ...Object.values(sessionsByProject).flat(),
    ...Object.values(childSessionsByParent).flat(),
  ];
  const orderedVisibleSessions = sortPinnedSessionsFirst(
    allVisibleSessions,
    (session) => pinnedSessionIdSet.has(session.id),
  );
  const collectedPinnedRootSessions = Object.entries(sessionsByProject).flatMap(
    ([projectId, sessions]) => sessions
      .filter((session) => pinnedSessionIdSet.has(session.id))
      .map((session) => ({ projectId, session, created: session.created })),
  );
  const orderedPinnedRootSessions = orderSessionsForAgent(collectedPinnedRootSessions, activeAgent);
  const pinnedRootSessions = runningFirst
    ? sortRunningSessionsFirst(
        orderedPinnedRootSessions,
        ({ session }) => isSessionRunning(session),
      )
    : orderedPinnedRootSessions;
  const allKnownSessions = allVisibleSessions;
  const sessionQueryTrim = sessionQuery.trim().toLowerCase();
  const searchResults = sessionQueryTrim
    ? orderedVisibleSessions.filter((s) =>
        s.title.toLowerCase().includes(sessionQueryTrim) ||
        (s.cwd || "").toLowerCase().includes(sessionQueryTrim))
    : null;
  const selectedSession = selectedSessionId
    ? allKnownSessions.find((session) => session.id === selectedSessionId)
    : undefined;
  const selectedSessionTitle = selectedSession?.title;
  const selectedWorkspacePath = selectedSession?.cwd
    || projects.find((project) => project.id === selectedProjectId)?.description
    || null;
  const collapsibleProjectIds = projects
    .filter((project) => !invalidProjectIds.has(project.id))
    .map((project) => project.id);
  // 失效（路径不存在、带感叹号）的目录沉到列表末尾，正常目录保持在前面。
  const orderedSidebarProjects = [
    ...projects.filter((project) => !invalidProjectIds.has(project.id)),
    ...projects.filter((project) => invalidProjectIds.has(project.id)),
  ];
  const allProjectsCollapsed = collapsibleProjectIds.length > 0
    && collapsibleProjectIds.every((projectId) => !expandedProjects.has(projectId));

  const [sidebarWidth, setSidebarWidth] = useState(300);
  const [sidebarDragging, setSidebarDragging] = useState(false);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const handleDrag = useCallback((e: MouseEvent) => {
    if (!isDragging.current) return;
    const w = Math.min(480, Math.max(160, dragStartWidth.current + e.clientX - dragStartX.current));
    setSidebarWidth(w);
  }, []);

  const stopDrag = useCallback(() => {
    isDragging.current = false;
    setSidebarDragging(false);
    document.removeEventListener("mousemove", handleDrag);
    document.removeEventListener("mouseup", stopDrag);
  }, [handleDrag]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
    setSidebarDragging(true);
    dragStartX.current = e.clientX;
    dragStartWidth.current = sidebarWidth;
    document.addEventListener("mousemove", handleDrag);
    document.addEventListener("mouseup", stopDrag);
  }, [sidebarWidth, handleDrag, stopDrag]);

  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "info" | "error">("success");

  const applySidebarSelection = (selection: SidebarSelection) => {
    selectedProjectIdRef.current = selection.projectId;
    selectedSessionIdRef.current = selection.sessionId;
    setSelectedProjectId(selection.projectId);
    setSelectedSessionId(selection.sessionId);
    if (!selection.sessionId) setTodos([]);
  };

  const handleAgentChange = (agentType: AgentType) => {
    if (agentType === activeAgentRef.current) return;
    const currentAgent = activeAgentRef.current;
    const currentPartition = workspaceCacheRef.current.agents[currentAgent];
    if (currentPartition) {
      workspaceCacheRef.current = {
        ...workspaceCacheRef.current,
        agents: {
          ...workspaceCacheRef.current.agents,
          [currentAgent]: {
            ...currentPartition,
            sidebarScrollTop: sidebarScrollRef.current?.scrollTop ?? currentPartition.sidebarScrollTop,
          },
        },
      };
    }
    const partition = workspaceCacheRef.current.agents[agentType] ?? emptyAgentWorkspacePartition();
    const cachedSessions = buildCachedSessionState(
      partition.sessions as Record<string, { data: Session[]; loaded: boolean }>,
      agentType,
    );
    const nextProjects = partition.workspaces.map(workspaceToProject);
    activeAgentRef.current = agentType;
    projectsRef.current = nextProjects;
    setActiveAgent(agentType);
    setProjects(nextProjects);
    setWorkspaceNextCursor(partition.nextCursor);
    setWorkspaceWatermark(partition.watermark);
    setWorkspaceLoading(false);
    setWorkspaceStale(false);
    setWorkspaceError(null);
    sessionsByProjectRef.current = cachedSessions.roots;
    childSessionsByParentRef.current = cachedSessions.children;
    setSessionsByProject(cachedSessions.roots);
    setChildSessionsByParent(cachedSessions.children);
    setLoadedProjectIds(cachedSessions.projectIds);
    loadedProjectIdsRef.current = cachedSessions.projectIds;
    setLoadingProjectIds(new Set());
    loadingProjectIdsRef.current = new Set();
    setProjectSessionErrors({});
    setStaleProjectIds(new Set());
    setSessionNextCursors(Object.fromEntries(
      Object.entries(partition.sessions).map(([id, entry]) => [id, entry.nextCursor]),
    ));
    setExpandedProjects(new Set(partition.expandedWorkspaceIds));
    setInvalidProjectIds(new Set());
    applySidebarSelection({
      projectId: partition.selectedWorkspaceId,
      sessionId: partition.selectedSessionId,
    });
    window.requestAnimationFrame(() => {
      if (sidebarScrollRef.current) sidebarScrollRef.current.scrollTop = partition.sidebarScrollTop;
    });
    void loadProjects(agentType, {
      refresh: partition.workspaces.length > 0,
      since: partition.watermark,
    });
  };

  // ── Toast notifications for sub-session events ──────────────────────────
  interface Toast {
    id: string;
    type: 'info' | 'success' | 'error';
    title: string;
    body: string;
    sessionId?: string;
  }
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);
  const addToast = useCallback((t: Omit<Toast, 'id'>) => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { ...t, id }]);
    setTimeout(() => dismissToast(id), 12000);
  }, [dismissToast]);

  async function loadProjects(
    agentType: AgentType = activeAgentRef.current,
    options: {
      refresh?: boolean;
      cursor?: string | null;
      since?: string | null;
      refreshLoadedSessions?: boolean;
    } = {},
  ) {
    if (!window.agentApi) return;
    const requestId = (workspaceRequestIds.current.get(agentType) ?? 0) + 1;
    workspaceRequestIds.current.set(agentType, requestId);
    setWorkspaceLoading(true);
    setWorkspaceError(null);
    try {
      const page = await window.agentApi.listAgentWorkspaces(agentType, {
        cursor: options.cursor,
        limit: 50,
        refresh: options.refresh,
        since: options.refresh ? (options.since ?? workspaceWatermark) : null,
      });
      if (activeAgentRef.current !== agentType || workspaceRequestIds.current.get(agentType) !== requestId) return;
      const current = projectsRef.current.map((project, order): AgentWorkspace => ({
        agentType,
        workspaceId: project.id,
        name: project.name,
        roots: project.description ? [project.description] : [],
        order,
        updatedAt: project.updated,
        source: project.source ?? (agentType === "claude-code" ? "derived" : "native"),
        canCreateSession: project.canCreateSession,
      }));
      const workspaces = reconcileWorkspacePage(current, page, !options.cursor);
      const list = workspaces.map(workspaceToProject);
      projectsRef.current = list;
      setProjects(list);
      setWorkspaceNextCursor(page.nextCursor);
      setWorkspaceWatermark(page.watermark);
      setWorkspaceStale(page.stale === true);
      const projectIds = new Set(list.map((project) => project.id));
      const restoredProjectId = selectedProjectIdRef.current;
      if (restoredProjectId && !projectIds.has(restoredProjectId)) {
        applySidebarSelection(EMPTY_SIDEBAR_SELECTION);
      }
      const cachedProjectIds = new Set(
        [...loadedProjectIdsRef.current].filter((projectId) => projectIds.has(projectId)),
      );
      if (restoredProjectId && projectIds.has(restoredProjectId)) {
        cachedProjectIds.add(restoredProjectId);
      }
      setSessionsByProject((prev) => Object.fromEntries(
        Object.entries(prev).filter(([projectId]) => projectIds.has(projectId)),
      ));
      setLoadedProjectIds((prev) => {
        const next = new Set([...prev].filter((projectId) => projectIds.has(projectId)));
        loadedProjectIdsRef.current = next;
        return next;
      });
      setLoadingProjectIds((prev) => {
        const next = new Set([...prev].filter((projectId) => projectIds.has(projectId)));
        loadingProjectIdsRef.current = next;
        return next;
      });
      setProjectSessionErrors((prev) => Object.fromEntries(
        Object.entries(prev).filter(([projectId]) => projectIds.has(projectId)),
      ));

      const invalid = new Set<string>();
      await Promise.all(list.map(async (project) => {
        if (project.description && !(await window.agentApi!.checkProjectPath(project.description))) {
          invalid.add(project.id);
        }
      }));
      if (activeAgentRef.current !== agentType || workspaceRequestIds.current.get(agentType) !== requestId) return;
      setInvalidProjectIds(invalid);

      // Cached rows render immediately; page one then refreshes in place.
      if (options.refreshLoadedSessions !== false) {
        for (const projectId of cachedProjectIds) {
          if (invalid.has(projectId) || loadingProjectIdsRef.current.has(projectId)) continue;
          void loadSessions(projectId, { refresh: true, background: true });
        }
      }
    } catch (error) {
      if (activeAgentRef.current === agentType) {
        if (projectsRef.current.length > 0) setWorkspaceStale(true);
        setWorkspaceError(error instanceof Error ? error.message : "目录加载失败");
      }
    } finally {
      if (activeAgentRef.current === agentType && workspaceRequestIds.current.get(agentType) === requestId) {
        setWorkspaceLoading(false);
      }
    }
  }

  async function loadSessions(
    projectId: string,
    options: {
      refresh?: boolean;
      background?: boolean;
      cursor?: string | null;
      pendingSession?: Session;
    } = {},
  ) {
    if (!window.agentApi) return;
    const agentType = activeAgentRef.current;
    const requestKey = `${agentType}:${projectId}`;
    const requestId = (projectSessionRequestIds.current.get(requestKey) ?? 0) + 1;
    projectSessionRequestIds.current.set(requestKey, requestId);
    setLoadingProjectIds((prev) => {
      const next = new Set(prev).add(projectId);
      loadingProjectIdsRef.current = next;
      return next;
    });
    setProjectSessionErrors((prev) => {
      if (!(projectId in prev)) return prev;
      const next = { ...prev };
      delete next[projectId];
      return next;
    });

    try {
      const page = await window.agentApi.listAgentWorkspaceSessions(agentType, projectId, {
        cursor: options.cursor,
        limit: 20,
        refresh: options.refresh,
      }) as WorkspacePage<Session>;
      if (activeAgentRef.current !== agentType || projectSessionRequestIds.current.get(requestKey) !== requestId) return;

      const existingRoots = sessionsByProjectRef.current[projectId] ?? [];
      const pendingSession = options.pendingSession
        ? {
            ...options.pendingSession,
            projectId,
          }
        : undefined;
      const currentRoots = pendingSession
        ? [pendingSession, ...existingRoots.filter((session) => session.id !== pendingSession.id)]
        : existingRoots;
      const previousRootIds = new Set(currentRoots.map((session) => session.id));
      const current = [
        ...currentRoots,
        ...[...previousRootIds].flatMap((rootId) => childSessionsByParentRef.current[rootId] ?? []),
      ];
      const list = (reconcileSessionPage(current, page, !options.cursor) as Session[])
        .map((session) => ({ ...session, projectId: session.projectId ?? projectId }));
      const refreshedRoots = orderSessionsForAgent(
        list.filter((session) => !session.parentSessionId),
        agentType,
      );
      const activeProjectId = selectedProjectIdRef.current;
      const activeSessionId = selectedSessionIdRef.current;
      const roots = preservePendingNativeSession(refreshedRoots, pendingSession) as Session[];
      if (
        activeProjectId === projectId
        && activeSessionId
        && !list.some((session) => session.id === activeSessionId)
        && !roots.some((session) => session.id === activeSessionId)
      ) {
        applySidebarSelection(EMPTY_SIDEBAR_SELECTION);
      }
      const freshChildGroups: Record<string, Session[]> = {};
      for (const child of list.filter((session) => session.parentSessionId)) {
        (freshChildGroups[child.parentSessionId!] ??= []).push(child);
      }
      for (const children of Object.values(freshChildGroups)) {
        children.sort((left, right) => left.created.localeCompare(right.created));
      }

      setSessionNextCursors((prev) => ({ ...prev, [projectId]: page.nextCursor }));
      setStaleProjectIds((prev) => {
        const next = new Set(prev);
        if (page.stale) next.add(projectId); else next.delete(projectId);
        return next;
      });
      const nextSessionsByProject = { ...sessionsByProjectRef.current, [projectId]: roots };
      const nextChildSessionsByParent = { ...childSessionsByParentRef.current };
      for (const rootId of previousRootIds) delete nextChildSessionsByParent[rootId];
      for (const [rootId, children] of Object.entries(freshChildGroups)) {
        nextChildSessionsByParent[rootId] = children;
      }
      sessionsByProjectRef.current = nextSessionsByProject;
      childSessionsByParentRef.current = nextChildSessionsByParent;
      setSessionsByProject(nextSessionsByProject);
      setChildSessionsByParent(nextChildSessionsByParent);
      setLoadedProjectIds((prev) => {
        const next = new Set(prev).add(projectId);
        loadedProjectIdsRef.current = next;
        return next;
      });
    } catch (error) {
      if (projectSessionRequestIds.current.get(requestKey) !== requestId) return;
      setProjectSessionErrors((prev) => ({
        ...prev,
        [projectId]: error instanceof Error ? error.message : "会话加载失败",
      }));
    } finally {
      if (projectSessionRequestIds.current.get(requestKey) === requestId) {
        setLoadingProjectIds((prev) => {
          const next = new Set(prev);
          next.delete(projectId);
          loadingProjectIdsRef.current = next;
          return next;
        });
      }
    }
  }

  /** Load child sessions for a specific parent (called after agent_dispatch) */
  const loadChildSessions = async (parentSessionId: string) => {
    if (!window.agentApi) return;
    const list = await window.agentApi.listChildSessions(parentSessionId) as Session[];
    setChildSessionsByParent((prev) => ({
      ...prev,
      [parentSessionId]: list.sort((a, b) => (a.created < b.created ? -1 : 1)),
    }));
  };

  const handleNewRuntimeSession = async (projectId: string, agentType: AgentType) => {
    if (!window.agentApi) return;
    const workspace = projectsRef.current.find((project) => project.id === projectId);
    if (!workspace || workspace.canCreateSession === false) {
      setNotice("请先选择目录");
      setNoticeType("info");
      setTimeout(() => setNotice(null), 3000);
      return;
    }
    if (sessionCreationPendingRef.current) return;
    sessionCreationPendingRef.current = true;
    setSessionCreationPending({ projectId, agentType });
    try {
      const nativeProjectId = workspace?.source === "imported" ? undefined : projectId;
      const created = await window.agentApi.createSession(
        "新会话",
        nativeProjectId,
        agentType,
        workspace?.description,
      ) as Session;
      if (activeAgentRef.current !== agentType) return;

      // Native runtimes may hide a fresh empty session from discovery. Insert
      // every successful creation immediately and reconcile CA in the background.
      const projectSession = created.projectId === projectId ? created : { ...created, projectId };
      const nextSessionsByProject = {
        ...sessionsByProjectRef.current,
        [projectId]: [
          projectSession,
          ...(sessionsByProjectRef.current[projectId] ?? []).filter((session) => session.id !== created.id),
        ],
      };
      sessionsByProjectRef.current = nextSessionsByProject;
      setSessionsByProject(nextSessionsByProject);
      applySidebarSelection({ projectId, sessionId: created.id });
      if (mobileDrawer) setSidebarDrawerOpen(false);
      if (agentType === "customer-agent") {
        void loadSessions(projectId, {
          refresh: true,
          background: true,
          pendingSession: projectSession,
        });
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "新建会话失败");
      setNoticeType("error");
      setTimeout(() => setNotice(null), 3000);
    } finally {
      sessionCreationPendingRef.current = false;
      setSessionCreationPending(null);
    }
  };

  const handleBottomNewSession = () => {
    const selectedWorkspace = projectsRef.current.find((project) => project.id === selectedProjectId);
    if (!selectedProjectId || selectedWorkspace?.canCreateSession === false) {
      setNotice("请先选择目录");
      setNoticeType("info");
      setTimeout(() => setNotice(null), 3000);
      return;
    }
    void handleNewRuntimeSession(selectedProjectId, activeAgent);
  };

  useEffect(() => {
    if (!window.agentApi) return;
    // Projects are the only blocking sidebar request. Settings and runtime
    // health hydrate independently; sessions load when a project is opened.
    void loadProjects(activeAgentRef.current, {
      refresh: (workspaceCacheRef.current.agents[activeAgentRef.current]?.workspaces.length ?? 0) > 0,
    });
    void useSettingsStore.getState().loadFromSystem();
    void window.agentApi.getRuntimeHealth().then(setRuntimeHealth).catch(() => undefined);
    // loadProjects is stable for the lifetime of this mounted App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible" || workspaceLoading) return;
      void loadProjects(activeAgent, {
        refresh: true,
        since: workspaceWatermark,
        refreshLoadedSessions: false,
      });
    }, 15_000);
    return () => window.clearInterval(timer);
    // Active Agent and its watermark define the incremental workspace poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAgent, workspaceLoading, workspaceWatermark]);

  useEffect(() => {
    if (
      !selectedProjectId
      || !selectedSessionId
      || !window.agentApi
    ) return;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      if (!cancelled) {
        await loadSessions(selectedProjectId, { refresh: true, background: true });
      }
    };
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Session identity and project registration are the only inputs relevant
    // to native ownership polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId, selectedSessionId, selectedSession?.agentType]);

  // Sync working directory whenever the selected project changes (covers startup,
  // session click, new session, and explicit project click).
  useEffect(() => {
    if (!selectedProjectId || !window.agentApi) return;
    const proj = projects.find((p) => p.id === selectedProjectId);
    const path = proj?.description;
    if (path) void window.agentApi.setProjectWorkingDir(path);
  }, [selectedProjectId, projects]);

  /** Project rows establish the workspace context and independently control disclosure. */
  const handleToggleProject = (projectId: string) => {
    applySidebarSelection(selectProject(projectId));
    const opening = !expandedProjects.has(projectId);
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (opening) next.add(projectId); else next.delete(projectId);
      return next;
    });
    if (opening && !loadingProjectIdsRef.current.has(projectId)) {
      const hasCache = loadedProjectIdsRef.current.has(projectId);
      const project = projectsRef.current.find((candidate) => candidate.id === projectId);
      const shouldRefresh = shouldRefreshWorkspaceSessions(
        activeAgentRef.current,
        project,
        hasCache,
      );
      void loadSessions(projectId, { refresh: shouldRefresh, background: hasCache });
    }
  };

  const importProjectPath = async (selectedPath: string) => {
    if (!window.agentApi) throw new Error("agentApi 未就绪，请重启应用");
    const normalizedPath = selectedPath.replace(/\\/g, "/");
    const segments = normalizedPath.split("/").filter(Boolean);
    const name = segments[segments.length - 1] || normalizedPath || "导入的项目";
    const result = await window.agentApi.importAgentWorkspace(
      activeAgentRef.current,
      normalizedPath,
      name,
    ) as ImportAgentWorkspaceResult;
    await loadProjects(activeAgentRef.current, { refresh: true, refreshLoadedSessions: false });
    applySidebarSelection(selectProject(result.workspace.workspaceId));
    await loadSessions(result.workspace.workspaceId, { refresh: true });
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      next.add(result.workspace.workspaceId);
      return next;
    });
    setNotice(result.existing
      ? "该文件夹已在当前 Agent 的目录中"
      : `已导入：${result.workspace.name}`);
    setNoticeType(result.existing ? "info" : "success");
    setTimeout(() => setNotice(null), 3000);
  };

  const handleImportProject = async () => {
    try {
      if (!window.agentApi) {
        setNotice("agentApi 未就绪，请重启应用");
        setNoticeType("error");
        return;
      }
      if (webShell) {
        setHostProjectPickerOpen(true);
        return;
      }
      const selectedPath = await window.agentApi.openFileDialog();
      console.log("[import] selectedPath:", selectedPath);
      if (!selectedPath) return;
      await importProjectPath(selectedPath);
    } catch (err) {
      console.error("[import] error:", err);
      setNotice(err instanceof Error ? err.message : String(err));
      setNoticeType("error");
      setTimeout(() => setNotice(null), 5000);
    }
  };

  const handleDeleteProject = async (projectId: string) => {
    if (!window.agentApi) return;
    try {
      await window.agentApi.deleteProject(projectId);
      if (selectedProjectId === projectId) {
        setSelectedProjectId(null);
        setSelectedSessionId(null);
        setTodos([]);
      }
      setNotice("项目删除成功");
      setNoticeType("success");
      setTimeout(() => setNotice(null), 2500);
      await loadProjects();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "项目删除失败");
      setNoticeType("error");
      setTimeout(() => setNotice(null), 4000);
    }
  };

  const requestDeleteSession = (session: Session, anchor: SidebarDeleteAnchor) => {
    setSessionDeleteRequest({ session, anchor });
  };

  const requestInvalidWorkspaceDelete = (project: Project, anchorElement: HTMLElement) => {
    const rect = anchorElement.getBoundingClientRect();
    setInvalidWorkspaceDeleteRequest({
      project,
      anchor: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
  };

  // 失效目录（路径不存在）由其下会话推导而来，没有单独的存储条目可删：
  // 删除 = 逐个归档其下全部会话，条目随之从工作区列表消失。
  const confirmInvalidWorkspaceDelete = async () => {
    if (!window.agentApi || !invalidWorkspaceDeleteRequest || invalidWorkspaceDeletePending) return;
    const { project } = invalidWorkspaceDeleteRequest;
    const agentType = activeAgentRef.current;
    setInvalidWorkspaceDeletePending(true);
    try {
      let cursor: string | null = null;
      let deleted = 0;
      do {
        const page = await window.agentApi.listAgentWorkspaceSessions(agentType, project.id, {
          cursor,
          limit: 50,
          refresh: cursor === null,
        }) as WorkspacePage<Session>;
        for (const session of page.data) {
          await window.agentApi.deleteSession(session.id);
          deleted += 1;
        }
        cursor = page.data.length > 0 ? page.nextCursor : null;
      } while (cursor);
      if (selectedProjectIdRef.current === project.id) {
        applySidebarSelection(EMPTY_SIDEBAR_SELECTION);
      }
      setNotice(deleted > 0 ? `已删除目录「${project.name}」及 ${deleted} 个会话` : `已删除目录「${project.name}」`);
      setNoticeType("success");
      setTimeout(() => setNotice(null), 2500);
      await loadProjects(agentType, { refresh: true });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "目录删除失败");
      setNoticeType("error");
      setTimeout(() => setNotice(null), 4000);
    } finally {
      setInvalidWorkspaceDeletePending(false);
      setInvalidWorkspaceDeleteRequest(null);
    }
  };

  const confirmDeleteSession = async () => {
    if (!window.agentApi || !sessionDeleteRequest || sessionDeletePending) return;
    const { session } = sessionDeleteRequest;
    setSessionDeletePending(true);
    try {
      await window.agentApi.deleteSession(session.id);
      const ownerProjectId = session.projectId ?? selectedProjectIdRef.current;
      const agentType = session.agentType;
      if (ownerProjectId) {
        const requestKey = `${agentType}:${ownerProjectId}`;
        projectSessionRequestIds.current.set(
          requestKey,
          (projectSessionRequestIds.current.get(requestKey) ?? 0) + 1,
        );
      }
      const removal = removeSessionFromCollections(
        sessionsByProjectRef.current,
        childSessionsByParentRef.current,
        [],
        session.id,
      );
      sessionsByProjectRef.current = removal.sessionsByProject;
      childSessionsByParentRef.current = removal.childSessionsByParent;
      setSessionsByProject(removal.sessionsByProject);
      setChildSessionsByParent(removal.childSessionsByParent);
      removePinnedSessions(removal.removedIds);
      const partition = workspaceCacheRef.current.agents[agentType];
      if (partition) {
        const cache = {
          ...workspaceCacheRef.current,
          agents: {
            ...workspaceCacheRef.current.agents,
            [agentType]: removeSessionIdsFromWorkspacePartition(partition, removal.removedIds),
          },
        };
        workspaceCacheRef.current = cache;
        writeAgentWorkspaceCache(cache);
      }
      if (selectedSessionIdRef.current && removal.removedIds.includes(selectedSessionIdRef.current)) {
        applySidebarSelection({ projectId: selectedProjectIdRef.current, sessionId: null });
      }
      setNotice("会话删除成功");
      setNoticeType("success");
      setTimeout(() => setNotice(null), 2500);
      setSessionDeleteRequest(null);
      if (ownerProjectId) void loadSessions(ownerProjectId, { refresh: true, background: true });
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "会话删除失败");
      setNoticeType("error");
      setTimeout(() => setNotice(null), 4000);
    } finally {
      setSessionDeletePending(false);
    }
  };

  const settingsTabs: { id: SettingsTab; label: string }[] = [
    { id: "settings", label: "设置" },
    { id: "mcp", label: "MCP" },
    { id: "memory", label: "记忆" },
    { id: "skill", label: "技能" },
    { id: "agent", label: "智能体" },
    { id: "lsp", label: "LSP" },
  ];

  const renderRootSession = (session: Session, projectId: string) => {
    const isActiveSession = selectedSessionId === session.id;
    const running = isSessionRunning(session);
    const visualState = getSidebarSessionVisualState({
      status: session.status,
      isRunning: running,
      needsInput: running && sessionsNeedingInput.includes(session.id),
    });
    const children = childSessionsByParent[session.id] ?? [];
    const expanded = !collapsedParents.has(session.id);

    return (
      <div key={session.id} className="sidebar-session-tree">
        <SidebarSessionRow
          session={{
            id: session.id,
            title: session.title,
            visualState,
            statusLabel: SIDEBAR_SESSION_STATUS_LABELS[visualState],
            occupiedExternally: session.agentType !== "codex"
              && session.occupancy === "owned-externally",
            canDelete: session.canDelete,
            active: isActiveSession,
            hasChildren: children.length > 0,
            expanded,
            compatibility: session.compatibility,
            pinned: pinnedSessionIdSet.has(session.id),
          }}
          onSelect={() => {
            if (mobileDrawer) setSidebarDrawerOpen(false);
            applySidebarSelection(selectSession(projectId, session.id));
            if (children.length > 0) {
              setCollapsedParents((prev) => {
                const next = new Set(prev);
                if (next.has(session.id)) next.delete(session.id); else next.add(session.id);
                return next;
              });
            }
          }}
          onPin={() => togglePinnedSession(session.id)}
          onDelete={(anchor) => requestDeleteSession(session, anchor)}
        />
        <div
          className="sidebar-child-sessions"
          style={{
            maxHeight: expanded ? children.length * 40 : 0,
            opacity: expanded ? 1 : 0,
          }}
        >
          {children.map((child) => {
            const childRunning = isSessionRunning(child);
            const childVisualState = getSidebarSessionVisualState({
              status: child.status,
              isRunning: childRunning,
              needsInput: childRunning && sessionsNeedingInput.includes(child.id),
            });
            return (
              <SidebarSessionRow
                key={child.id}
                session={{
                  id: child.id,
                  title: child.title,
                  visualState: childVisualState,
                  statusLabel: SIDEBAR_SESSION_STATUS_LABELS[childVisualState],
                  occupiedExternally: child.agentType !== "codex"
                    && child.occupancy === "owned-externally",
                  canDelete: child.canDelete,
                  active: selectedSessionId === child.id,
                  child: true,
                  compatibility: child.compatibility,
                }}
                deleteLabel="删除子会话"
                onSelect={() => {
                  if (mobileDrawer) setSidebarDrawerOpen(false);
                  applySidebarSelection(selectSession(projectId, child.id));
                }}
                onDelete={(anchor) => requestDeleteSession(child, anchor)}
              />
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="app-shell" style={{
      display: "flex",
      height: webShell ? "100dvh" : "100vh",
      width: "100vw",
      background: "var(--bg-deepest)",
      position: "relative",
      overflow: "hidden",
    }}>
      <UpdateNotice />
      <DesktopLiveControlBanner />
      {/* Web mobile: drawer mask + hamburger */}
      {mobileDrawer && sidebarDrawerOpen && (
        <div
          className="mobile-drawer-scrim"
          onClick={() => setSidebarDrawerOpen(false)}
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 1150 }}
        />
      )}
      {mobileDrawer && !sidebarDrawerOpen && (
        <button
          className="mobile-drawer-toggle"
          onClick={() => setSidebarDrawerOpen(true)}
          aria-label="会话列表"
          aria-expanded={false}
          style={{
            position: "fixed",
            top: "calc(env(safe-area-inset-top) + 8px)",
            left: 10,
            zIndex: 1250,
            width: 34,
            height: 34,
            borderRadius: 9,
            border: "1px solid var(--border-default)",
            background: "var(--bg-glass, rgba(18,20,28,.82))",
            color: "var(--text-secondary)",
            display: "grid",
            placeItems: "center",
            backdropFilter: "blur(8px)",
            WebkitAppRegion: "no-drag",
            cursor: "pointer",
          } as React.CSSProperties}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
      )}
      {/* Invisible drag region across the full top — covers titlebar height */}
      <div className="app-drag-region" style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 52,
        zIndex: 9999,
        WebkitAppRegion: "drag",
        pointerEvents: "none",
      } as React.CSSProperties} />
      <div className="app-accent-glow" style={{
        position: "absolute",
        top: "-120px",
        left: "-80px",
        width: 320,
        height: 320,
        borderRadius: "50%",
        background: "radial-gradient(circle, var(--accent-glow) 0%, transparent 70%)",
        pointerEvents: "none",
        zIndex: 0,
      }} />

      {layout !== "focus" && (
      <>
      <aside
        className="app-sidebar"
        style={{
          width: sidebarWidth,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-surface)",
          borderRight: "1px solid var(--border-subtle)",
          padding: "56px 0 0",
          position: "relative",
          zIndex: 10,
          overflow: "hidden",
          ...(mobileDrawer ? {
            position: "fixed" as const,
            top: 0,
            bottom: 0,
            left: 0,
            width: "min(82vw, 320px)",
            zIndex: 1200,
            transform: sidebarDrawerOpen ? "translateX(0)" : "translateX(-103%)",
            transition: "transform .24s ease",
            boxShadow: "12px 0 32px rgba(0,0,0,.5)",
            padding: "calc(env(safe-area-inset-top) + 12px) 0 0",
          } : {}),
        }}
      >
        {/* Logo / brand */}
        <div className="app-sidebar-brand" style={{
          padding: "0 20px 10px",
        }}>
          <div className="sidebar-brand-row">
            <div className="sidebar-brand-mark" aria-hidden="true">
              <AgentBrandIcon agentType="customer-agent" size={24} />
            </div>
            <span className="sidebar-brand-name">AgentRoam</span>
          </div>
        </div>

        <AgentWorkspaceSwitcher
          value={activeAgent}
          health={runtimeHealth}
          onChange={handleAgentChange}
        />

        <button
          type="button"
          className="sidebar-search-field"
          onClick={() => { setSearchOpen(true); setSearchListLimit(10); }}
          title="搜索会话"
          aria-label="搜索会话"
        >
          <Search size={15} aria-hidden="true" />
          <span>搜索会话</span>
          <kbd>⌘ K</kbd>
        </button>

        <div className="sidebar-project-toolbar">
          <div className="sidebar-project-heading">
            <span className="sidebar-project-title">目录</span>
            <span className="sidebar-project-count" aria-label={`${projects.length} 个目录`}>{projects.length}</span>
          </div>
          <div className="sidebar-project-actions">
            <button
              type="button"
              onClick={(event) => {
                if (allProjectsCollapsed) handleExpandAllSessions(); else handleCollapseAllSessions();
                blurDeactivatedPointerToggle(event, allProjectsCollapsed);
              }}
              title={allProjectsCollapsed ? "展开全部会话" : "折叠全部会话"}
              aria-label={allProjectsCollapsed ? "展开全部会话" : "折叠全部会话"}
              aria-pressed={allProjectsCollapsed}
              disabled={collapsibleProjectIds.length === 0}
              className={`ui-icon-button sidebar-collapse-all${allProjectsCollapsed ? " is-active" : ""}`}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {allProjectsCollapsed ? (
                  <>
                    <path d="m7 6 5 5 5-5" />
                    <path d="m7 13 5 5 5-5" />
                  </>
                ) : (
                  <>
                    <path d="m17 11-5-5-5 5" />
                    <path d="m17 18-5-5-5 5" />
                  </>
                )}
              </svg>
            </button>
            <button
              type="button"
              onClick={(event) => {
                setRunningFirst(!runningFirst);
                blurDeactivatedPointerToggle(event, runningFirst);
              }}
              title={runningFirst ? "按新建时间排序" : "进行中会话优先"}
              aria-label={runningFirst ? "按新建时间排序" : "进行中会话优先"}
              aria-pressed={runningFirst}
              className={`ui-icon-button sidebar-session-sort${runningFirst ? " is-active" : ""}`}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 6h10M3 12h7M3 18h4" />
                <path d="m15 9 3-3 3 3M18 6v12" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => void handleImportProject()}
              title="导入目录"
              aria-label="导入目录"
              className="ui-icon-button"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>

        {/* Project + session list */}
        <div
          ref={sidebarScrollRef}
          className="app-sidebar-scroll"
          onPointerDownCapture={blurActiveTextEntry}
          onScroll={(event) => {
            const element = event.currentTarget;
            const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
            if (nearBottom && workspaceNextCursor && !workspaceLoading) {
              void loadProjects(activeAgent, { cursor: workspaceNextCursor });
            }
          }}
          style={{ flex: 1, overflow: "auto", padding: "0 10px" }}
        >
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 }}>
            {pinnedRootSessions.length > 0 && (
              <section className="sidebar-pinned-section" aria-label="置顶会话">
                <div className="sidebar-pinned-heading">置顶</div>
                {pinnedRootSessions.map(({ projectId, session }) => renderRootSession(session, projectId))}
              </section>
            )}
            {orderedSidebarProjects.map((project) => {
              const isSelected = selectedProjectId === project.id;
              const isExpanded = expandedProjects.has(project.id);
              const hasLoadedProject = loadedProjectIds.has(project.id);
              const isProjectLoading = loadingProjectIds.has(project.id);
              const projectSessionError = projectSessionErrors[project.id];
              const projectSessions = sessionsByProject[project.id] ?? [];
              const unpinnedProjectSessions = projectSessions.filter(
                (session) => !pinnedSessionIdSet.has(session.id),
              );
              const orderedProjectSessions = runningFirst
                ? sortRunningSessionsFirst(unpinnedProjectSessions, isSessionRunning)
                : unpinnedProjectSessions;
              const projSessions = orderedProjectSessions;
              const manySession = projSessions.length > 10;
              const isInvalid = invalidProjectIds.has(project.id);
              const isCreatingSession = sessionCreationPending?.agentType === activeAgent
                && sessionCreationPending.projectId === project.id;
              return (
                <div key={project.id} className="sidebar-project-block" aria-busy={isProjectLoading}>
                  {/* Project row */}
                  <div
                    className={`sidebar-row sidebar-project-row ${isSelected && !isInvalid ? "sidebar-row-active" : ""}`}
                    style={{ paddingRight: 4, opacity: isInvalid ? 0.45 : 1 }}
                  >
                    <button
                      className="sidebar-project-button"
                      onClick={() => {
                        if (isInvalid) return;
                        handleToggleProject(project.id);
                      }}
                      disabled={isInvalid}
                      aria-expanded={isExpanded}
                      aria-pressed={isSelected}
                      title={isInvalid ? `路径不存在：${project.description}` : project.name}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                        padding: "8px 10px",
                        border: "none",
                        background: "transparent",
                        color: isInvalid ? "var(--text-muted)" : (isSelected ? "var(--accent)" : "var(--text-secondary)"),
                        fontSize: 13,
                        fontWeight: isSelected && !isInvalid ? 600 : 400,
                        cursor: isInvalid ? "not-allowed" : "pointer",
                        textAlign: "left" as const,
                        transition: "color 0.15s",
                      }}
                    >
                      {isInvalid ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                      ) : project.canCreateSession === false ? (
                        <History size={13} aria-hidden="true" style={{ flexShrink: 0, opacity: isSelected ? 1 : 0.5 }} />
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: isSelected ? 1 : 0.5 }}>
                          {isExpanded
                            ? <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.46 20H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
                            : <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />}
                        </svg>
                      )}
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {project.name}
                      </span>
                    </button>
                    {activeAgent === "customer-agent" && !webShell ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDeleteProject(project.id); }}
                        title="删除目录"
                        aria-label={`删除目录：${project.name}`}
                        className="sidebar-project-delete sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                        style={{
                          flexShrink: 0,
                        }}
                      >
                        <SidebarDeleteIcon />
                      </button>
                    ) : isInvalid ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); requestInvalidWorkspaceDelete(project, e.currentTarget); }}
                        title="删除失效目录"
                        aria-label={`删除失效目录：${project.name}`}
                        className="sidebar-project-delete sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                        style={{
                          flexShrink: 0,
                        }}
                      >
                        <SidebarDeleteIcon />
                      </button>
                    ) : null}
                    {project.canCreateSession !== false && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void handleNewRuntimeSession(project.id, activeAgent);
                        }}
                        title={isCreatingSession
                          ? "正在创建会话"
                          : `新建 ${activeAgent === "customer-agent" ? "Customer Agent" : activeAgent === "claude-code" ? "Claude Code" : activeAgent === "codex" ? "Codex" : "OpenCode"} 会话`}
                        aria-label={isCreatingSession ? "正在创建会话" : `在 ${project.name} 中新建会话`}
                        aria-busy={isCreatingSession}
                        disabled={
                          sessionCreationPending !== null
                          || isInvalid
                          || runtimeHealth.find((runtime) => runtime.agentType === activeAgent)?.available === false
                        }
                        className="sidebar-runtime-create sidebar-project-add-action ui-icon-button ui-icon-button--small"
                      >
                        {isCreatingSession
                          ? <LoaderCircle size={13} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
                          : <Plus size={13} aria-hidden="true" />}
                      </button>
                    )}
                  </div>

                  {/* Sessions under this project — collapsible, scrollable when > 10 */}
                  <div style={{
                    overflow: "hidden",
                    maxHeight: isExpanded ? (manySession ? 300 : 800) : 0,
                    opacity: isExpanded ? 1 : 0,
                    transition: "max-height 0.45s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease",
                  }}>
                    <div
                      className="sidebar-project-sessions"
                      onScroll={(event) => {
                        const element = event.currentTarget;
                        const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
                        const nextCursor = sessionNextCursors[project.id];
                        if (nearBottom && nextCursor && !isProjectLoading) {
                          void loadSessions(project.id, { cursor: nextCursor });
                        }
                      }}
                      style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 2, paddingLeft: 10, paddingBottom: 4, ...(manySession ? { maxHeight: 280, overflowY: "auto" as const } : {}) }}
                    >
                      {projSessions.map((session) => renderRootSession(session, project.id))}
                      {isProjectLoading && !hasLoadedProject && (
                        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: "4px 10px", opacity: 0.7 }}>
                          正在加载会话...
                        </div>
                      )}
                      {projectSessionError && (
                        <div
                          title={projectSessionError}
                          style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--danger)", fontSize: 11, padding: "4px 10px" }}
                        >
                          <span style={{ flex: 1 }}>会话加载失败</span>
                          <button
                            type="button"
                            onClick={() => void loadSessions(project.id, { refresh: hasLoadedProject, background: hasLoadedProject })}
                            style={{ border: 0, background: "transparent", color: "inherit", fontSize: 11, cursor: "pointer", padding: 0 }}
                          >
                            重试
                          </button>
                        </div>
                      )}
                      {staleProjectIds.has(project.id) && !projectSessionError && (
                        <div className="sidebar-cache-state">显示缓存，会话将在下次刷新时更新</div>
                      )}
                      {projectSessions.length === 0 && hasLoadedProject && !isProjectLoading && !projectSessionError && (
                        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: "4px 10px", opacity: 0.7 }}>
                          暂无会话
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {projects.length === 0 && (
              <div style={{
                color: "var(--text-muted)", fontSize: 12,
                padding: "24px 10px", textAlign: "center", opacity: 0.7,
              }}>
                {workspaceLoading ? "正在加载目录..." : "暂无目录"}
              </div>
            )}
            {projects.length > 0 && workspaceLoading && (
              <div className="sidebar-cache-state">正在同步目录...</div>
            )}
            {workspaceStale && !workspaceError && (
              <div className="sidebar-cache-state">当前显示缓存目录</div>
            )}
            {workspaceError && (
              <div className="sidebar-load-error" title={workspaceError}>
                <span>{projects.length > 0 ? "目录刷新失败，当前显示缓存" : "目录加载失败"}</span>
                <button type="button" onClick={() => void loadProjects(activeAgent, { refresh: projects.length > 0 })}>重试</button>
              </div>
            )}
          </div>
        </div>

        <div className="sidebar-bottom-action">
          <button
            type="button"
            className="sidebar-new-session-primary"
            disabled={
              sessionCreationPending !== null
              || (selectedProjectId !== null && invalidProjectIds.has(selectedProjectId))
              || runtimeHealth.find((runtime) => runtime.agentType === activeAgent)?.available === false
            }
            aria-busy={sessionCreationPending !== null}
            aria-disabled={
              sessionCreationPending !== null
              || !selectedProjectId
              || projects.find((project) => project.id === selectedProjectId)?.canCreateSession === false
            }
            title={
              sessionCreationPending
                ? "正在创建会话"
                : selectedProjectId
              && projects.find((project) => project.id === selectedProjectId)?.canCreateSession !== false
                ? "新建会话"
                : "请先选择目录"
            }
            onClick={handleBottomNewSession}
          >
            {sessionCreationPending ? (
              <>
                <LoaderCircle size={16} style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true" />
                <span>正在创建...</span>
              </>
            ) : (
              <>
                <Plus size={16} aria-hidden="true" />
                <span>新建会话</span>
              </>
            )}
          </button>
        </div>

      </aside>

      {sessionDeleteRequest && (
        <SidebarDeleteConfirmation
          message={sessionDeletionConfirmation(sessionDeleteRequest.session)}
          anchor={sessionDeleteRequest.anchor}
          mobile={mobileDrawer}
          pending={sessionDeletePending}
          onCancel={() => setSessionDeleteRequest(null)}
          onConfirm={() => void confirmDeleteSession()}
        />
      )}

      {invalidWorkspaceDeleteRequest && (
        <SidebarDeleteConfirmation
          title="删除失效目录"
          message={`目录「${invalidWorkspaceDeleteRequest.project.name}」的路径（${invalidWorkspaceDeleteRequest.project.description || "未知"}）已不存在。删除将同时归档其下的全部会话记录，确定删除吗？`}
          anchor={invalidWorkspaceDeleteRequest.anchor}
          mobile={mobileDrawer}
          pending={invalidWorkspaceDeletePending}
          onCancel={() => setInvalidWorkspaceDeleteRequest(null)}
          onConfirm={() => void confirmInvalidWorkspaceDelete()}
        />
      )}

      {!mobileDrawer && (
      <div
        className={`app-sidebar-resizer${sidebarDragging ? " is-dragging" : ""}`}
        onMouseDown={startDrag}
        style={{
          left: sidebarWidth,
        }}
      />
      )}

      {searchOpen && (
        <div
          onClick={() => setSearchOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1300,
            background: "rgba(17,24,39,0.34)",
            backdropFilter: "blur(2px)",
            WebkitBackdropFilter: "blur(2px)",
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "center",
            padding: "12vh 16px 16px",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(560px, 100%)",
              maxHeight: "64vh",
              display: "flex",
              flexDirection: "column",
              borderRadius: 12,
              border: "1px solid var(--border-default)",
              background: "var(--bg-surface)",
              boxShadow: "0 18px 48px rgba(17,24,39,0.28)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: 10, borderBottom: "1px solid var(--border-subtle)" }}>
              <input
                autoFocus
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setSearchOpen(false); }}
                placeholder="搜索所有会话（标题或目录）…"
                aria-label="搜索所有会话"
                style={{
                  width: "100%",
                  padding: "9px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border-default)",
                  background: "var(--bg-glass)",
                  color: "var(--text-primary)",
                  fontSize: 14,
                  outline: "none",
                  fontFamily: "var(--font-body)",
                  boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ overflowY: "auto", padding: 8 }}>
              {sessionQueryTrim && searchResults && searchResults.length > 0 && (
                <div style={{
                  padding: "4px 10px 3px",
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: "0.08em",
                  textTransform: "uppercase",
                  color: "var(--text-muted)",
                }}>{searchResults.length} 个结果</div>
              )}
              {sessionQueryTrim && searchResults && searchResults.length === 0 && (
                <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "16px 10px", textAlign: "center", opacity: 0.7 }}>
                  无匹配会话
                </div>
              )}
              {!sessionQueryTrim && orderedVisibleSessions.length === 0 && (
                <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "16px 10px", textAlign: "center", opacity: 0.7 }}>
                  暂无会话
                </div>
              )}
              {(searchResults ?? orderedVisibleSessions.slice(0, searchListLimit)).map((session) => {
                const active = selectedSessionId === session.id;
                const running = isSessionRunning(session);
                const visualState = getSidebarSessionVisualState({
                  status: session.status,
                  isRunning: running,
                  needsInput: running && sessionsNeedingInput.includes(session.id),
                });
                return (
                  <SidebarSessionRow
                    key={session.id}
                    session={{
                      id: session.id,
                      title: session.title,
                      visualState,
                      statusLabel: SIDEBAR_SESSION_STATUS_LABELS[visualState],
                      occupiedExternally: session.agentType !== "codex"
                        && session.occupancy === "owned-externally",
                      canDelete: session.canDelete,
                      active,
                      child: Boolean(session.parentSessionId),
                      compatibility: session.compatibility,
                      pinned: pinnedSessionIdSet.has(session.id),
                    }}
                    onSelect={() => {
                      const projectId = session.projectId && projects.some((p) => p.id === session.projectId)
                        ? session.projectId
                        : null;
                      applySidebarSelection(selectSession(projectId, session.id));
                      setSearchOpen(false);
                      if (mobileDrawer) setSidebarDrawerOpen(false);
                    }}
                    onPin={session.parentSessionId ? undefined : () => togglePinnedSession(session.id)}
                    onDelete={(anchor) => requestDeleteSession(session, anchor)}
                  />
                );
              })}
              {!sessionQueryTrim && orderedVisibleSessions.length > searchListLimit && (
                <button
                  type="button"
                  onClick={() => setSearchListLimit((limit) => limit + 10)}
                  style={{
                    width: "100%",
                    padding: "8px 10px",
                    border: 0,
                    borderTop: "1px solid var(--border-subtle)",
                    background: "transparent",
                    color: "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    textAlign: "center",
                  }}
                >更多…</button>
              )}
            </div>
          </div>
        </div>
      )}
      </>
      )}

      {notice && createPortal(
        <div
          className={`app-action-notice is-${noticeType}`}
          role={noticeType === "error" ? "alert" : "status"}
          aria-live={noticeType === "error" ? "assertive" : "polite"}
        >
          <span className="app-action-notice-mark" aria-hidden="true">
            {noticeType === "success" ? "✓" : noticeType === "info" ? "i" : "!"}
          </span>
          <span>{notice}</span>
        </div>,
        document.body,
      )}

      <main className="app-main" style={{
        flex: 1,
        overflow: "hidden",
        background: "var(--bg-workspace)",
        position: "relative",
        zIndex: 5,
      }}>
        {/* Focus layout: floating restore-sidebar chip */}
        {layout === "focus" && (
          <button
            onClick={() => setLayout("standard")}
            title="返回标准布局"
            style={{
              position: "absolute", top: 12, left: 12, zIndex: 100,
              padding: "5px 10px", borderRadius: 8,
              border: "1px solid var(--border-default)",
              background: "var(--bg-glass)",
              color: "var(--text-muted)", fontSize: 11,
              cursor: "pointer", backdropFilter: "blur(8px)",
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties}
          >← 侧边栏</button>
        )}
        <div style={{ height: "100%", paddingTop: 0, display: hubOpen ? "none" : undefined }}>
          <ChatView
            activeAgentType={activeAgent}
            selectedProjectId={selectedProjectId}
            selectedSessionId={selectedSessionId}
            sessionTitle={selectedSessionTitle}
            sessionSummary={selectedSession}
            workspacePath={selectedWorkspacePath}
            voiceCommand={voiceCommand}
            onOpenSettings={toggleSettings}
            settingsOpen={showSettings}
            desktopLiveOpen={showDesktopLive}
            onOpenDesktopLive={!webShell && window.agentApi?.desktopLiveGetStatus ? () => setShowDesktopLive(true) : undefined}
            onHideToBackground={() => void hideToBackground()}
            onOpenHub={window.agentApi?.hubGetConfig ? () => setHubOpen(true) : undefined}
            onToggleAppearance={toggleAppearance}
            appearanceOpen={showAppearance}
            hideToBackgroundTitle={wakeEnabled ? `隐藏到后台（说“${wakeWord}”唤醒）` : "隐藏到后台"}
            onSessionCreated={async (sessionId, pendingSession) => {
              const projectId = selectedProjectIdRef.current;
              applySidebarSelection({ projectId, sessionId });
              // Arm two-way voice conversation for voice-originated sessions
              if (pendingVoiceConvo.current) {
                pendingVoiceConvo.current = false;
                convoRef.current = { sessionId, until: Date.now() + 90000 };
                void window.agentApi?.wakeConversation(true);
              }
              if (projectId) await loadSessions(projectId, { pendingSession });
            }}
            onSubSessionCreated={async (parentSessionId) => {
              await loadChildSessions(parentSessionId);
            }}
            onSelectSession={(sessionId) => {
              setSelectedSessionId(sessionId);
            }}
            onSubAgentEvent={(ev) => {
              if (ev.type === 'started') {
                addToast({ type: 'info', title: `子会话已启动`, body: `${ev.agentName}：${ev.task.slice(0, 60)}`, sessionId: ev.subSessionId });
              } else if (ev.type === 'completed') {
                addToast({ type: 'success', title: `子会话已完成`, body: `${ev.agentName}：${ev.task.slice(0, 60)}`, sessionId: ev.subSessionId });
              } else {
                addToast({ type: 'error', title: `子会话出错`, body: `${ev.agentName}：${ev.task.slice(0, 60)}`, sessionId: ev.subSessionId });
              }
            }}
            onMessageSent={(sessionId, latestMessage) => {
              // Optimistically update title immediately — no DB sync here
              setSessionsByProject((prev) => {
                const updated: Record<string, Session[]> = {};
                for (const [pid, sessions] of Object.entries(prev)) {
                  updated[pid] = sessions.map((s) =>
                    s.id === sessionId
                      ? { ...s, title: latestMessage.slice(0, 60) || s.title }
                      : s
                  );
                }
                return updated;
              });
            }}
            onRunComplete={async (projId, completedSessionId) => {
              const currentConversation = convoRef.current;
              const renewedConversation = renewVoiceConversation(currentConversation, completedSessionId);
              convoRef.current = renewedConversation;
              if (renewedConversation !== currentConversation) {
                void window.agentApi?.wakeConversation(true);
              }
              const projectId = projId || selectedProjectId;
              if (projectId) {
                await loadSessions(projectId, { refresh: true, background: true });
              }
            }}
          />
        </div>

        {/* AI Hub（多 AI 网页聚合）：与 ChatView 互斥显示 */}
        {hubOpen && (
          <AIHubView conversationId={selectedSessionId} onExit={() => setHubOpen(false)} />
        )}

        {/* modal moved to portal below */}
      </main>

      {showDesktopLive && <DesktopLiveDialog onClose={() => setShowDesktopLive(false)} />}

      {showSettings && createPortal(
          <div
            onClick={() => setShowSettings(false)}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 10001,
              background: "rgba(17,24,39,0.18)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              animation: "fadeIn 0.2s var(--ease-out)",
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(920px, calc(100vw - 48px))",
                height: "min(760px, calc(100vh - 48px))",
                background: "var(--bg-surface)",
                border: "1px solid var(--border-default)",
                borderRadius: "var(--radius-md)",
                backdropFilter: "blur(14px)",
                WebkitBackdropFilter: "blur(14px)",
                boxShadow: "var(--shadow-md)",
                overflow: "hidden",
                display: "flex",
                flexDirection: "column",
                animation: "fadeInUp 0.25s var(--ease-out)",
              }}
            >
              <div style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottom: "1px solid var(--border-subtle)",
                padding: "8px 10px",
                background: "var(--bg-deepest)",
              }}>
                <div style={{ display: "flex", gap: 6 }}>
                  {settingsTabs.map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setSettingsTab(tab.id)}
                      className={`settings-tab ${settingsTab === tab.id ? "settings-tab-active" : ""}`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowSettings(false)}
                  title="关闭"
                  className="ui-icon-button ui-icon-button--close ui-icon-button--danger"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                    <path d="M18 6 6 18M6 6l12 12"/>
                  </svg>
                </button>
              </div>

              <div style={{ flex: 1, overflow: "auto" }}>
                {settingsTab === "settings" && <SettingsPanel />}
                {settingsTab === "mcp" && <MCPServerList />}
                {settingsTab === "memory" && <MemoryViewer />}
                {settingsTab === "skill" && <SkillManager />}
                {settingsTab === "agent" && <AgentManager />}
                {settingsTab === "lsp" && <LSPServerList />}
              </div>
            </div>
          </div>
        , document.body)}

      <div className="noise-overlay" />

      {/* ── Appearance panel (skins / layout / voice) ── */}
      {showAppearance && appearanceAnchor && createPortal(
        <div
          onClick={() => setShowAppearance(false)}
          style={{ position: "fixed", inset: 0, zIndex: 10000, WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="appearance-panel"
            style={{
              position: "absolute",
              left: Math.max(12, Math.min(appearanceAnchor.right - 320, window.innerWidth - 332)),
              top: appearanceAnchor.bottom + 8,
              width: 320,
              maxHeight: `calc(100vh - ${appearanceAnchor.bottom + 20}px)`,
              overflowY: "auto",
              background: "var(--bg-surface)",
              border: "1px solid var(--border-default)",
              borderRadius: "var(--radius-md)",
              boxShadow: "var(--shadow-md)",
              padding: "16px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
              animation: "fadeInUp 0.2s var(--ease-out)",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
            }}
          >
            {/* Skins */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 8 }}>皮肤</div>
              <div className="appearance-choices">
                {SKINS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => setSkin(s.id)}
                    className={`appearance-choice ${skin === s.id ? "appearance-choice-active" : ""}`}
                  >
                    <span className="appearance-swatch" style={{
                      background: `linear-gradient(135deg, ${s.preview[0]} 55%, ${s.preview[1]} 55%)`,
                    }} />
                    <span className="appearance-choice-label" style={{ fontWeight: skin === s.id ? 600 : 400 }}>{s.label}</span>
                    {skin === s.id && (
                      <svg className="appearance-choice-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m5 12 4 4L19 6" />
                      </svg>
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Layouts */}
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.08em", marginBottom: 8 }}>布局</div>
              <div className="appearance-segmented">
                {LAYOUTS.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => setLayout(l.id)}
                    title={l.description}
                    className={`appearance-segment ${layout === l.id ? "appearance-segment-active" : ""}`}
                  >{l.label}</button>
                ))}
              </div>
            </div>

            {/* Voice settings */}
            <div style={{ display: "flex", flexDirection: "column", gap: 10, borderTop: "1px solid var(--border-subtle)", paddingTop: 12 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase" as const, letterSpacing: "0.08em" }}>语音</div>
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
                助手回复自动播报
                <input className="appearance-switch" type="checkbox" checked={autoSpeak} onChange={(e) => setAutoSpeak(e.target.checked)} />
              </label>
              <label style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 12, color: "var(--text-secondary)", cursor: "pointer" }}>
                隐藏后语音唤醒
                <input className="appearance-switch" type="checkbox" checked={wakeEnabled} onChange={(e) => setWakeEnabled(e.target.checked)} />
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-secondary)" }}>
                <span style={{ flexShrink: 0 }}>唤醒词</span>
                <input
                  value={wakeWord}
                  onChange={(e) => setWakeWord(e.target.value || "小智")}
                  style={{
                    flex: 1,
                    padding: "4px 8px",
                    borderRadius: 6,
                    border: "1px solid var(--border-default)",
                    background: "var(--bg-deep)",
                    color: "var(--text-primary)",
                    fontSize: 12,
                  }}
                />
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {/* ── Wake-up animation overlay ── */}
      <HostProjectPicker
        open={hostProjectPickerOpen}
        onCancel={() => setHostProjectPickerOpen(false)}
        onConfirm={async (path) => {
          await importProjectPath(path);
          setHostProjectPickerOpen(false);
        }}
      />

      <WakeOverlay trigger={wakeTrigger} heardText={wakeHeard} />

      {/* ── Toast notifications (bottom-right) ── */}
      {toasts.length > 0 && createPortal(
        <div style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          zIndex: 20000,
          display: "flex",
          flexDirection: "column",
          gap: 10,
          alignItems: "flex-end",
          pointerEvents: "none",
        }}>
          {toasts.map((toast) => (
            <div
              key={toast.id}
              style={{
                pointerEvents: "auto",
                width: 320,
                background: "var(--bg-surface)",
                border: `1px solid ${toast.type === 'error' ? 'rgba(220,38,38,0.25)' : toast.type === 'success' ? 'rgba(5,150,105,0.25)' : 'var(--border-default)'}`,
                borderLeft: `3px solid ${toast.type === 'error' ? 'var(--danger)' : toast.type === 'success' ? 'var(--success)' : 'var(--accent)'}`,
                borderRadius: "var(--radius-md)",
                boxShadow: "var(--shadow-md)",
                padding: "12px 14px",
                animation: "fadeInUp 0.22s var(--ease-out)",
                backdropFilter: "blur(12px)",
                WebkitBackdropFilter: "blur(12px)",
              }}
            >
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{
                  fontSize: 12,
                  fontWeight: 600,
                  color: toast.type === 'error' ? 'var(--danger)' : toast.type === 'success' ? 'var(--success)' : 'var(--accent)',
                  display: "flex",
                  alignItems: "center",
                  gap: 5,
                }}>
                  {toast.type === 'error' ? '✕' : toast.type === 'success' ? '✓' : '◎'} {toast.title}
                </span>
                <button
                  onClick={() => dismissToast(toast.id)}
                  title="关闭"
                  style={{
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--text-muted)",
                    fontSize: 14,
                    lineHeight: 1,
                    padding: "2px 4px",
                    borderRadius: 4,
                    transition: "color 0.15s",
                  }}
                  onMouseEnter={e => (e.currentTarget.style.color = "var(--text-primary)")}
                  onMouseLeave={e => (e.currentTarget.style.color = "var(--text-muted)")}
                >×</button>
              </div>
              {/* Body */}
              <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5, wordBreak: "break-all" }}>
                {toast.body}
              </p>
              {/* Jump-to-session button */}
              {toast.sessionId && (
                <button
                  onClick={() => { setSelectedSessionId(toast.sessionId!); dismissToast(toast.id); }}
                  style={{
                    marginTop: 8,
                    padding: "4px 10px",
                    fontSize: 11,
                    fontWeight: 500,
                    background: "var(--accent-dim)",
                    color: "var(--accent)",
                    border: "1px solid var(--border-glow)",
                    borderRadius: 6,
                    cursor: "pointer",
                    transition: "background 0.15s",
                    WebkitAppRegion: "no-drag",
                  } as React.CSSProperties}
                  onMouseEnter={e => (e.currentTarget.style.background = "var(--accent-glow)")}
                  onMouseLeave={e => (e.currentTarget.style.background = "var(--accent-dim)")}
                >
                  进入会话 →
                </button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
