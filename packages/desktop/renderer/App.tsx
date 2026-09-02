import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import ChatView from "./components/ChatView";
import { renewVoiceConversation } from "./lib/voice-command";
import {
  getSidebarSessionVisualState,
  SIDEBAR_SESSION_STATUS_LABELS,
} from "./lib/sidebar-session-status";
import {
  sortNewestSessionsFirst,
  sortRunningSessionsFirst,
} from "./lib/sidebar-session-sort";
import SettingsPanel from "./components/SettingsPanel";
import MCPServerList from "./components/MCPServerList";
import MemoryViewer from "./components/MemoryViewer";
import SkillManager from "./components/SkillManager";
import AgentManager from "./components/AgentManager";
import LSPServerList from "./components/LSPServerList";
import WakeOverlay from "./components/WakeOverlay";
import RuntimeSessionMenu from "./components/RuntimeSessionMenu";
import HostProjectPicker from "./components/HostProjectPicker";
import type { AgentType, RuntimeHealth } from "./global";
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
}

const RUNTIME_MARKS: Record<AgentType, string> = {
  "customer-agent": "CA",
  codex: "CX",
  "claude-code": "CC",
};

const OTHER_GROUP_LABELS: Record<AgentType, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "customer-agent": "Customer Agent",
};

/** 机器人分组在侧边栏中的固定展示顺序 */
const BOT_GROUP_ORDER: AgentType[] = ["customer-agent", "claude-code", "codex"];
const SESSION_INDEX_CACHE_KEY = "agentroam.session-index.v1";

function readSessionIndexCache(): Record<string, Session[]> {
  try {
    const cached = JSON.parse(localStorage.getItem(SESSION_INDEX_CACHE_KEY) ?? "{}") as unknown;
    if (!cached || typeof cached !== "object" || Array.isArray(cached)) return {};
    return Object.fromEntries(
      Object.entries(cached).filter(([, sessions]) => Array.isArray(sessions)),
    ) as Record<string, Session[]>;
  } catch {
    return {};
  }
}

function writeProjectSessionCache(projectId: string, sessions: Session[]): void {
  try {
    localStorage.setItem(SESSION_INDEX_CACHE_KEY, JSON.stringify({
      ...readSessionIndexCache(),
      [projectId]: sessions,
    }));
  } catch {
    // A full or unavailable browser store must not block live session loading.
  }
}

function pruneSessionIndexCache(projectIds: Set<string>): void {
  try {
    const cache = readSessionIndexCache();
    const next = Object.fromEntries(
      Object.entries(cache).filter(([projectId]) => projectIds.has(projectId)),
    );
    localStorage.setItem(SESSION_INDEX_CACHE_KEY, JSON.stringify(next));
  } catch {
    // Cache cleanup is best-effort.
  }
}

function buildCachedSessionState(cache: Record<string, Session[]>) {
  const roots: Record<string, Session[]> = {};
  const children: Record<string, Session[]> = {};
  for (const [projectId, sessions] of Object.entries(cache)) {
    roots[projectId] = sortNewestSessionsFirst(
      sessions.filter((session) => !session.parentSessionId),
    );
    for (const child of sessions.filter((session) => session.parentSessionId)) {
      (children[child.parentSessionId!] ??= []).push(child);
    }
  }
  for (const group of Object.values(children)) {
    group.sort((left, right) => left.created.localeCompare(right.created));
  }
  return { roots, children, projectIds: new Set(Object.keys(cache)) };
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

export default function App() {
  const [initialSessionState] = useState(() => buildCachedSessionState(readSessionIndexCache()));
  const [projects, setProjects] = useState<Project[]>([]);
  const [hostProjectPickerOpen, setHostProjectPickerOpen] = useState(false);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>(initialSessionState.roots);
  const [otherLocalSessions, setOtherLocalSessions] = useState<Session[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchListLimit, setSearchListLimit] = useState(10);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth[]>([]);
  /** Child sessions keyed by parentSessionId */
  const [childSessionsByParent, setChildSessionsByParent] = useState<Record<string, Session[]>>(initialSessionState.children);
  /** Projects whose sessions have completed at least one successful load. */
  const [loadedProjectIds, setLoadedProjectIds] = useState<Set<string>>(initialSessionState.projectIds);
  const [loadingProjectIds, setLoadingProjectIds] = useState<Set<string>>(new Set());
  const [projectSessionErrors, setProjectSessionErrors] = useState<Record<string, string>>({});
  const projectSessionRequestIds = useRef(new Map<string, number>());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  /** Set of parent session IDs whose children are collapsed */
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  /** Set of project IDs whose session list is expanded */
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  /** Set of `${projectId}::${agentType}` bot-group keys whose sessions are collapsed */
  const [collapsedBotGroups, setCollapsedBotGroups] = useState<Set<string>>(new Set());
  /** Project IDs whose working directory path no longer exists on disk */
  const [invalidProjectIds, setInvalidProjectIds] = useState<Set<string>>(new Set());

  const [showSettings, setShowSettings] = useState(false);
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
  const groupByBot = useUIStore((s) => s.groupByBot);
  const setGroupByBot = useUIStore((s) => s.setGroupByBot);
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

  /** 当前项目内存在的机器人分组 key，按项目顺序 × BOT_GROUP_ORDER 排列 */
  const botGroupKeysInOrder = useCallback(() => {
    const keys: string[] = [];
    for (const project of projects) {
      const list = sessionsByProject[project.id] ?? [];
      for (const botType of BOT_GROUP_ORDER) {
        if (list.some((s) => s.agentType === botType)) keys.push(`${project.id}::${botType}`);
      }
    }
    return keys;
  }, [projects, sessionsByProject]);

  /** Collapse every project and nested session group in the sidebar. */
  const handleCollapseAllSessions = () => {
    setExpandedProjects(new Set());
    setCollapsedBotGroups(new Set(botGroupKeysInOrder()));
    setCollapsedParents(new Set(Object.keys(childSessionsByParent)));
  };
  /** Expand every valid project and nested session group in the sidebar. */
  const handleExpandAllSessions = () => {
    const projectIds = projects
      .filter((project) => !invalidProjectIds.has(project.id))
      .map((project) => project.id);
    setExpandedProjects(new Set(projectIds));
    setCollapsedBotGroups(new Set());
    setCollapsedParents(new Set());
    for (const projectId of projectIds) {
      if (loadingProjectIdsRef.current.has(projectId)) continue;
      const hasCache = loadedProjectIdsRef.current.has(projectId);
      void loadSessions(projectId, { refresh: hasCache, background: hasCache });
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

  // Apply skin / layout to the DOM
  useEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
  }, [skin]);
  useEffect(() => {
    document.body.classList.toggle("layout-compact", layout === "compact");
  }, [layout]);

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

  const allVisibleSessions = Object.values(sessionsByProject).flat();
  const allKnownSessions = [...allVisibleSessions, ...otherLocalSessions];
  const sessionQueryTrim = sessionQuery.trim().toLowerCase();
  const searchResults = sessionQueryTrim
    ? allVisibleSessions.filter((s) =>
        s.title.toLowerCase().includes(sessionQueryTrim) ||
        (s.cwd || "").toLowerCase().includes(sessionQueryTrim))
    : null;
  const selectedSession = selectedSessionId
    ? allKnownSessions.find((session) => session.id === selectedSessionId)
    : undefined;
  const selectedSessionTitle = selectedSession?.title;
  const collapsibleProjectIds = projects
    .filter((project) => !invalidProjectIds.has(project.id))
    .map((project) => project.id);
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
  const [noticeType, setNoticeType] = useState<"success" | "error">("success");

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

  async function loadProjects() {
    if (!window.agentApi) return;
    const list = await window.agentApi.listProjects() as Project[];
    setProjects(list);
    const projectIds = new Set(list.map((project) => project.id));
    const cachedProjectIds = new Set(
      [...loadedProjectIdsRef.current].filter((projectId) => projectIds.has(projectId)),
    );
    pruneSessionIndexCache(projectIds);
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
    // Check which project paths still exist on disk
    const invalid = new Set<string>();
    await Promise.all(list.map(async (p) => {
      if (p.description && !(await window.agentApi!.checkProjectPath(p.description))) {
        invalid.add(p.id);
      }
    }));
    setInvalidProjectIds(invalid);

    // Cached rows make startup immediate, then a project-scoped refresh brings
    // newly discovered native sessions into the sidebar without another click.
    for (const projectId of cachedProjectIds) {
      if (invalid.has(projectId) || loadingProjectIdsRef.current.has(projectId)) continue;
      void loadSessions(projectId, { refresh: true, background: true });
    }
  }

  async function loadSessions(
    projectId: string,
    options: { refresh?: boolean; background?: boolean } = {},
  ) {
    if (!window.agentApi) return;
    const requestId = (projectSessionRequestIds.current.get(projectId) ?? 0) + 1;
    projectSessionRequestIds.current.set(projectId, requestId);
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
      const list = options.refresh
        ? await window.agentApi.refreshSessions(projectId) as Session[]
        : await window.agentApi.listSessions(projectId) as Session[];
      if (projectSessionRequestIds.current.get(projectId) !== requestId) return;

      const previousRootIds = new Set((sessionsByProject[projectId] ?? []).map((session) => session.id));
      const roots = sortNewestSessionsFirst(
        list.filter((session) => !session.parentSessionId),
      );
      const selectedPendingNative = (sessionsByProject[projectId] ?? []).find((session) => (
        session.id === selectedSessionId
        && session.agentType !== "customer-agent"
        && !roots.some((fresh) => fresh.id === session.id)
      ));
      if (selectedPendingNative) roots.unshift(selectedPendingNative);
      const freshChildGroups: Record<string, Session[]> = {};
      for (const child of list.filter((session) => session.parentSessionId)) {
        (freshChildGroups[child.parentSessionId!] ??= []).push(child);
      }
      for (const children of Object.values(freshChildGroups)) {
        children.sort((left, right) => left.created.localeCompare(right.created));
      }

      writeProjectSessionCache(projectId, [
        ...roots,
        ...Object.values(freshChildGroups).flat(),
      ]);
      setSessionsByProject((prev) => ({ ...prev, [projectId]: roots }));
      setChildSessionsByParent((prev) => {
        const next = { ...prev };
        for (const rootId of previousRootIds) delete next[rootId];
        for (const [rootId, children] of Object.entries(freshChildGroups)) {
          next[rootId] = children;
        }
        return next;
      });
      setLoadedProjectIds((prev) => {
        const next = new Set(prev).add(projectId);
        loadedProjectIdsRef.current = next;
        return next;
      });
    } catch (error) {
      if (projectSessionRequestIds.current.get(projectId) !== requestId) return;
      setProjectSessionErrors((prev) => ({
        ...prev,
        [projectId]: error instanceof Error ? error.message : "会话加载失败",
      }));
    } finally {
      if (projectSessionRequestIds.current.get(projectId) === requestId) {
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
    const created = await window.agentApi.createSession("新会话", projectId, agentType) as Session;
    if (agentType === "customer-agent") {
      await loadSessions(projectId);
      setSelectedProjectId(projectId);
      setSelectedSessionId(created.id);
      if (mobileDrawer) setSidebarDrawerOpen(false);
      return;
    }
    // Native runtimes hide freshly created empty sessions from discovery until
    // the first turn runs. Keep the optimistic row under the project where the
    // user created it so the project-only sidebar never loses the selection.
    const projectSession = created.projectId === projectId ? created : { ...created, projectId };
    setSessionsByProject((prev) => ({
      ...prev,
      [projectId]: [projectSession, ...(prev[projectId] ?? []).filter((s) => s.id !== created.id)],
    }));
    setOtherLocalSessions((prev) => prev.filter((s) => s.id !== created.id));
    setSelectedProjectId(projectId);
    setSelectedSessionId(created.id);
    if (mobileDrawer) setSidebarDrawerOpen(false);
  };

  useEffect(() => {
    if (!window.agentApi) return;
    // Projects are the only blocking sidebar request. Settings and runtime
    // health hydrate independently; sessions load when a project is opened.
    void loadProjects();
    void useSettingsStore.getState().loadFromSystem();
    void window.agentApi.getRuntimeHealth().then(setRuntimeHealth).catch(() => undefined);
    // loadProjects is stable for the lifetime of this mounted App.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      !selectedProjectId
      || !selectedSessionId
      || selectedSession?.agentType === "customer-agent"
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

  /** Toggle expand/collapse for a project; also selects it if switching from another project */
  const handleToggleProject = (projectId: string) => {
    const opening = !expandedProjects.has(projectId);
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (opening) next.add(projectId); else next.delete(projectId);
      return next;
    });
    if (selectedProjectId !== projectId) {
      setSelectedProjectId(projectId);
      setSelectedSessionId(null);
    }
    if (opening && !loadingProjectIdsRef.current.has(projectId)) {
      const hasCache = loadedProjectIdsRef.current.has(projectId);
      void loadSessions(projectId, { refresh: hasCache, background: hasCache });
    }
  };

  const importProjectPath = async (selectedPath: string) => {
    if (!window.agentApi) throw new Error("agentApi 未就绪，请重启应用");
    const normalizedPath = selectedPath.replace(/\\/g, "/");
    const segments = normalizedPath.split("/").filter(Boolean);
    const name = segments[segments.length - 1] || normalizedPath || "导入的项目";
    const created = await window.agentApi.createProject(name, normalizedPath) as Project;
    await loadProjects();
    setSelectedProjectId(created.id);
    setSelectedSessionId(null);
    await loadSessions(created.id);
    setExpandedProjects((prev) => { const n = new Set(prev); n.add(created.id); return n; });
    setNotice(`已导入：${name}`);
    setNoticeType("success");
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

  const handleDeleteSession = async (sessionId: string) => {
    if (!window.agentApi) return;
    try {
      await window.agentApi.deleteSession(sessionId);
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
        setTodos([]);
      }
      setNotice("会话删除成功");
      setNoticeType("success");
      setTimeout(() => setNotice(null), 2500);
      if (selectedProjectId) await loadSessions(selectedProjectId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "会话删除失败");
      setNoticeType("error");
      setTimeout(() => setNotice(null), 4000);
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

  return (
    <div className="app-shell" style={{
      display: "flex",
      height: webShell ? "100dvh" : "100vh",
      width: "100vw",
      background: "var(--bg-deepest)",
      position: "relative",
      overflow: "hidden",
    }}>
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
          padding: "56px 0 20px",
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
            padding: "calc(env(safe-area-inset-top) + 12px) 0 20px",
          } : {}),
        }}
      >
        {/* Logo / brand */}
        <div className="app-sidebar-brand" style={{
          padding: "0 20px 10px",
        }}>
          <div className="sidebar-brand-row">
            <div className="sidebar-brand-mark" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z" />
                <path d="M7 9h10M7 13h7" />
              </svg>
            </div>
            <span className="sidebar-brand-name">AgentRoam</span>
          </div>
        </div>

        <div className="sidebar-project-toolbar">
          <span className="sidebar-project-title">项目</span>
          <div className="sidebar-project-actions">
            <button
              type="button"
              onClick={() => { setSearchOpen(true); setSearchListLimit(10); }}
              title="搜索会话"
              aria-label="搜索会话"
              className="ui-icon-button"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setGroupByBot(!groupByBot)}
              title="会话按 Agent 分组"
              aria-label="会话按 Agent 分组"
              aria-pressed={groupByBot}
              className={`ui-icon-button${groupByBot ? " is-active" : ""}`}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6h.01M4 12h.01M4 18h.01" />
              </svg>
            </button>
            <button
              type="button"
              onClick={allProjectsCollapsed ? handleExpandAllSessions : handleCollapseAllSessions}
              title={allProjectsCollapsed ? "展开全部会话" : "折叠全部会话"}
              aria-label={allProjectsCollapsed ? "展开全部会话" : "折叠全部会话"}
              disabled={collapsibleProjectIds.length === 0}
              className="ui-icon-button"
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
              onClick={() => setRunningFirst(!runningFirst)}
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
              title="导入项目"
              aria-label="导入项目"
              className="ui-icon-button"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        </div>

        {notice && (
          <div style={{
            margin: "0 12px 10px",
            padding: "8px 10px",
            borderRadius: "var(--radius-sm)",
            border: noticeType === "success"
              ? "1px solid rgba(52,211,153,0.35)"
              : "1px solid rgba(244,63,94,0.35)",
            background: noticeType === "success"
              ? "rgba(52,211,153,0.08)"
              : "rgba(244,63,94,0.08)",
            color: noticeType === "success" ? "var(--success)" : "var(--danger)",
            fontSize: 12,
          }}>
            {notice}
          </div>
        )}

        {/* Project + session list */}
        <div className="app-sidebar-scroll" style={{ flex: 1, overflow: "auto", padding: "0 10px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 }}>
            {projects.map((project) => {
              const isSelected = selectedProjectId === project.id && !selectedSessionId;
              const isExpanded = expandedProjects.has(project.id);
              const hasLoadedProject = loadedProjectIds.has(project.id);
              const isProjectLoading = loadingProjectIds.has(project.id);
              const projectSessionError = projectSessionErrors[project.id];
              const projectSessions = sessionsByProject[project.id] ?? [];
              const projSessions = runningFirst
                ? sortRunningSessionsFirst(projectSessions, isSessionRunning)
                : projectSessions;
              const manySession = projSessions.length > 10;
              const isInvalid = invalidProjectIds.has(project.id);
              return (
                <div key={project.id} className="sidebar-project-block" aria-busy={isProjectLoading}>
                  {/* Project row */}
                  <div
                    className={`sidebar-row sidebar-project-row ${isSelected && !isInvalid ? "sidebar-row-active" : ""}`}
                    style={{ paddingRight: 4, opacity: isInvalid ? 0.45 : 1 }}
                  >
                    <button
                      className="sidebar-project-button"
                      onClick={() => { if (!isInvalid) void handleToggleProject(project.id); }}
                      disabled={isInvalid}
                      aria-expanded={isExpanded}
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
                      {projSessions.length > 0 && groupByBot && (
                        <span className="sidebar-count" style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, color: isSelected && !isInvalid ? "var(--accent)" : "var(--text-muted)", background: isSelected && !isInvalid ? "var(--accent-dim)" : "var(--bg-deep)", borderRadius: 8, padding: "0 5px", lineHeight: "15px", opacity: 0.8 }}>{projSessions.length}</span>
                      )}
                    </button>
                    {/* Delete project button */}
                    {!webShell && (
                      <button
                        onClick={(e) => { e.stopPropagation(); void handleDeleteProject(project.id); }}
                        title="删除项目"
                        aria-label={`删除项目：${project.name}`}
                        className="sidebar-project-delete sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                        style={{
                          flexShrink: 0,
                        }}
                      >
                        <SidebarDeleteIcon />
                      </button>
                    )}
                    <RuntimeSessionMenu
                      health={runtimeHealth}
                      disabled={isInvalid}
                      onSelect={(agentType) => handleNewRuntimeSession(project.id, agentType)}
                    />
                  </div>

                  {/* Sessions under this project — collapsible, scrollable when > 10 */}
                  <div style={{
                    overflow: "hidden",
                    maxHeight: isExpanded ? (manySession ? 300 : 800) : 0,
                    opacity: isExpanded ? 1 : 0,
                    transition: "max-height 0.45s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease",
                  }}>
                    <div
                      className={`sidebar-project-sessions${groupByBot ? " is-grouped" : ""}`}
                      style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 2, paddingLeft: 10, paddingBottom: 4, ...(manySession ? { maxHeight: 280, overflowY: "auto" as const } : {}) }}
                    >
                      {(() => {
                        const renderSession = (session: Session) => {
                        const isActiveSession = selectedSessionId === session.id;
                        const running = isSessionRunning(session);
                        const visualState = getSidebarSessionVisualState({
                          status: session.status,
                          isRunning: running,
                          needsInput: running && sessionsNeedingInput.includes(session.id),
                        });
                        const children = childSessionsByParent[session.id] ?? [];
                        return (
                          <div key={session.id}>
                          <div className={`sidebar-row sidebar-session-row ${isActiveSession ? "sidebar-row-active" : ""}`} style={{ paddingRight: 4 }}>
                            <button
                              className="sidebar-session-button"
                              onClick={() => {
                                if (mobileDrawer) setSidebarDrawerOpen(false);
                                setSelectedProjectId(project.id);
                                setSelectedSessionId(session.id);
                                if (children.length > 0) {
                                  setCollapsedParents((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(session.id)) next.delete(session.id); else next.add(session.id);
                                    return next;
                                  });
                                }
                              }}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                display: "flex",
                                alignItems: "center",
                                gap: 7,
                                padding: "6px 10px",
                                border: "none",
                                background: "transparent",
                                color: isActiveSession ? "var(--accent)" : "var(--text-secondary)",
                                fontSize: 12,
                                cursor: "pointer",
                                textAlign: "left" as const,
                                transition: "color 0.15s",
                              }}
                            >
                              {/* dot indicator — same style as sessions without children */}
                              <span
                                className={`sidebar-status-dot is-${visualState}`}
                                title={SIDEBAR_SESSION_STATUS_LABELS[visualState]}
                              />
                              <span title={session.sourceLabel} style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {session.title}
                              </span>
                              {session.occupancy === "owned-externally" && (
                                <span className="sidebar-occupancy-badge" title="原客户端正在使用，只读">占用</span>
                              )}
                              {children.length > 0 && groupByBot && (
                                <span className="sidebar-count" style={{
                                  flexShrink: 0, fontSize: 9, fontWeight: 600,
                                  color: isActiveSession ? "var(--accent)" : "var(--text-muted)",
                                  background: isActiveSession ? "var(--accent-dim)" : "var(--bg-deep)",
                                  borderRadius: 8, padding: "0 5px", lineHeight: "16px",
                                  opacity: 0.8,
                                }}>{children.length}</span>
                              )}
                              {children.length > 0 && (
                                <svg className={`sidebar-session-disclosure${collapsedParents.has(session.id) ? "" : " is-expanded"}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                  <path d="m9 18 6-6-6-6" />
                                </svg>
                              )}
                            </button>
                            {session.canDelete && <button
                              onClick={() => void handleDeleteSession(session.id)}
                              title="删除会话"
                              aria-label={`删除会话：${session.title}`}
                              className="sidebar-session-delete sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                            >
                              <SidebarDeleteIcon />
                            </button>}
                            {!groupByBot && (
                              <span className={`sidebar-runtime-mark sidebar-runtime-mark--${session.agentType}`}>
                                {RUNTIME_MARKS[session.agentType]}
                              </span>
                            )}
                          </div>
                          {/* Child sessions (sub-agents) — indented under parent, collapsible */}
                          <div style={{
                            overflow: "hidden",
                            maxHeight: collapsedParents.has(session.id) ? 0 : children.length * 40,
                            opacity: collapsedParents.has(session.id) ? 0 : 1,
                            transition: "max-height 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease",
                          }}>
                          {children.map((child) => {
                            const isChildActive = selectedSessionId === child.id;
                            return (
                              <div key={child.id} className={`sidebar-row ${isChildActive ? "sidebar-row-active" : ""}`} style={{
                                paddingRight: 4,
                                marginLeft: 14,
                                borderLeft: "1px solid var(--border-subtle)",
                              }}>
                                <button
                                  className="sidebar-session-button"
                                  onClick={() => { setSelectedProjectId(project.id); setSelectedSessionId(child.id); }}
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 6,
                                    padding: "5px 8px",
                                    border: "none",
                                    background: "transparent",
                                    color: isChildActive ? "var(--accent)" : "var(--text-muted)",
                                    fontSize: 11,
                                    cursor: "pointer",
                                    textAlign: "left" as const,
                                    transition: "color 0.15s",
                                  }}
                                >
                                  {/* sub-agent icon */}
                                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
                                    <path d="M12 2a5 5 0 1 0 0 10A5 5 0 0 0 12 2z"/><path d="M12 12c-5.33 0-8 2.67-8 4v2h16v-2c0-1.33-2.67-4-8-4z"/>
                                  </svg>
                                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                    {child.title}
                                  </span>
                                </button>
                                <button
                                  onClick={() => void handleDeleteSession(child.id)}
                                  title="删除子会话"
                                  aria-label={`删除子会话：${child.title}`}
                                  className="sidebar-session-delete sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                                >
                                  <SidebarDeleteIcon />
                                </button>
                              </div>
                            );
                          })}
                          </div>
                          </div>
                        );
                        };
                        if (!groupByBot) return projSessions.map(renderSession);
                        return BOT_GROUP_ORDER
                          .map((botType) => [botType, projSessions.filter((s) => s.agentType === botType)] as const)
                          .filter(([, list]) => list.length > 0)
                          .map(([botType, list]) => {
                            const groupKey = `${project.id}::${botType}`;
                            const groupExpanded = !collapsedBotGroups.has(groupKey);
                            return (
                              <div key={botType}>
                                <button
                                  type="button"
                                  className="sidebar-agent-group"
                                  onClick={() => setCollapsedBotGroups((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
                                    return next;
                                  })}
                                  aria-expanded={groupExpanded}
                                  title={OTHER_GROUP_LABELS[botType]}
                                  style={{
                                    width: "100%",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 7,
                                    padding: "5px 10px 2px 12px",
                                    border: 0,
                                    background: "transparent",
                                    color: "var(--text-muted)",
                                    fontSize: 9,
                                    fontWeight: 700,
                                    letterSpacing: "0.08em",
                                    textTransform: "uppercase",
                                    cursor: "pointer",
                                    textAlign: "left" as const,
                                  }}
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                    style={{ flexShrink: 0, opacity: 0.4, transform: groupExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.2s ease" }} aria-hidden="true">
                                    <path d="M6 9l6 6 6-6" />
                                  </svg>
                                  <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{OTHER_GROUP_LABELS[botType]}</span>
                                  <span className="sidebar-count" style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, background: "var(--bg-deep)", borderRadius: 8, padding: "0 5px", lineHeight: "15px", opacity: 0.8 }}>{list.length}</span>
                                </button>
                                <div style={{
                                  overflow: "hidden",
                                  maxHeight: groupExpanded ? list.length * 44 + 8 : 0,
                                  opacity: groupExpanded ? 1 : 0,
                                  transition: "max-height 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.25s ease",
                                }}>
                                  {list.map(renderSession)}
                                </div>
                              </div>
                            );
                          });
                      })()}
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
                      {projSessions.length === 0 && hasLoadedProject && !isProjectLoading && !projectSessionError && (
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
                暂无项目
              </div>
            )}
          </div>
        </div>

      </aside>

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
              {!sessionQueryTrim && allVisibleSessions.length === 0 && (
                <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "16px 10px", textAlign: "center", opacity: 0.7 }}>
                  暂无会话
                </div>
              )}
              {(searchResults ?? allVisibleSessions.slice(0, searchListLimit)).map((session) => {
                const active = selectedSessionId === session.id;
                return (
                  <div key={session.id} className={`sidebar-row ${active ? "sidebar-row-active" : ""}`}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedProjectId(session.projectId && projects.some((p) => p.id === session.projectId) ? session.projectId : null);
                        setSelectedSessionId(session.id);
                        setSearchOpen(false);
                        if (mobileDrawer) setSidebarDrawerOpen(false);
                      }}
                      title={`${session.sourceLabel}\n${session.cwd}`}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        display: "flex",
                        alignItems: "center",
                        gap: 7,
                        padding: "6px 10px",
                        border: 0,
                        background: "transparent",
                        color: active ? "var(--accent)" : "var(--text-secondary)",
                        fontSize: 12,
                        cursor: "pointer",
                        textAlign: "left",
                      }}
                    >
                      <span style={{
                        flexShrink: 0,
                        minWidth: 22,
                        padding: "1px 3px",
                        borderRadius: 3,
                        border: "1px solid var(--border-subtle)",
                        color: active ? "var(--accent)" : "var(--text-muted)",
                        fontSize: 8,
                        fontWeight: 700,
                        textAlign: "center",
                      }}>{RUNTIME_MARKS[session.agentType]}</span>
                      <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{session.title}</span>
                      {session.occupancy === "owned-externally" && (
                        <span title="原客户端正在使用，只读" aria-label="只读" style={{ display: "flex", flexShrink: 0 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                          </svg>
                        </span>
                      )}
                    </button>
                  </div>
                );
              })}
              {!sessionQueryTrim && allVisibleSessions.length > searchListLimit && (
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
        <div style={{ height: "100%", paddingTop: 0 }}>
          <ChatView
            selectedProjectId={selectedProjectId}
            selectedSessionId={selectedSessionId}
            sessionTitle={selectedSessionTitle}
            sessionSummary={selectedSession}
            voiceCommand={voiceCommand}
            onOpenSettings={toggleSettings}
            settingsOpen={showSettings}
            onHideToBackground={() => void hideToBackground()}
            onToggleAppearance={toggleAppearance}
            appearanceOpen={showAppearance}
            hideToBackgroundTitle={wakeEnabled ? `隐藏到后台（说“${wakeWord}”唤醒）` : "隐藏到后台"}
            onSessionCreated={async (sessionId) => {
              setSelectedSessionId(sessionId);
              // Arm two-way voice conversation for voice-originated sessions
              if (pendingVoiceConvo.current) {
                pendingVoiceConvo.current = false;
                convoRef.current = { sessionId, until: Date.now() + 90000 };
                void window.agentApi?.wakeConversation(true);
              }
              if (selectedProjectId) await loadSessions(selectedProjectId);
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
              setOtherLocalSessions((prev) => prev.map((session) => (
                session.id === sessionId
                  ? { ...session, title: latestMessage.slice(0, 60) || session.title }
                  : session
              )));
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

        {/* modal moved to portal below */}
      </main>

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
