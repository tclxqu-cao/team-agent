import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ChatView from "./components/ChatView";
import { renewVoiceConversation } from "./lib/voice-command";
import SettingsPanel from "./components/SettingsPanel";
import MCPServerList from "./components/MCPServerList";
import MemoryViewer from "./components/MemoryViewer";
import SkillManager from "./components/SkillManager";
import AgentManager from "./components/AgentManager";
import LSPServerList from "./components/LSPServerList";
import WakeOverlay from "./components/WakeOverlay";
import RuntimeSessionMenu from "./components/RuntimeSessionMenu";
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
const BOT_GROUP_ORDER: AgentType[] = ["customer-agent", "codex", "claude-code"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Derive a readable sub-group label for a session listed under 其他本机会话. */
function otherSessionGroup(session: Session, projectName?: string): { label: string; full: string } {
  if (projectName) return { label: projectName, full: projectName };
  const cwd = session.cwd || "";
  const segs = cwd.split("/").filter(Boolean);
  if (segs.length > 0) {
    // Worktree sessions belong to their repo: ~/.claude/worktrees/<branch>
    // keeps the repo before .claude; ~/.codex/worktrees/<hash>/<repo> keeps
    // the repo after the meaningless hash.
    const wt = segs.indexOf("worktrees");
    if (wt >= 2) {
      if (segs[wt - 1] === ".claude") {
        return { label: segs[wt - 2], full: cwd };
      }
      if (segs[wt - 1] === ".codex") {
        const repo = segs[wt + 2] || segs[wt + 1];
        if (repo) return { label: repo, full: cwd };
      }
    }
    // /Users/<name> itself is the home directory, not a project called <name>
    if (segs[0] === "Users" && segs.length === 2) return { label: "主目录", full: cwd };
    if (segs[0] === "Users") {
      const rel = segs.slice(2);
      if (rel.length <= 2) return { label: rel.join("/"), full: cwd };
      return { label: `…/${rel.slice(-2).join("/")}`, full: cwd };
    }
    return { label: segs[segs.length - 1], full: cwd };
  }
  // Server-backed sessions carry readable project slugs (e.g. "kid-earth-learning");
  // opaque uuids from deleted projects are not worth showing.
  if (session.projectId && !UUID_RE.test(session.projectId)) {
    return { label: session.projectId, full: session.projectId };
  }
  return { label: "未知项目", full: "" };
}

/** Stable sort that floats running sessions to the top, keeping recency order inside each partition. */
function runningFirstSort(sessions: Session[], isRunning: (s: Session) => boolean): Session[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => Number(isRunning(b.session)) - Number(isRunning(a.session)) || a.index - b.index)
    .map((entry) => entry.session);
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [otherLocalSessions, setOtherLocalSessions] = useState<Session[]>([]);
  const [otherLocalExpanded, setOtherLocalExpanded] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth[]>([]);
  /** Child sessions keyed by parentSessionId */
  const [childSessionsByParent, setChildSessionsByParent] = useState<Record<string, Session[]>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  /** Set of parent session IDs whose children are collapsed */
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(new Set());
  /** Set of directory keys (agentType::label) under 其他本机会话 whose sessions are collapsed */
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
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

  const isSessionRunning = useCallback(
    (session: Session) => session.status === "running" || runningSessionId === session.id,
    [runningSessionId],
  );

  /** 当前存在的机器人分组 key，按展示顺序（项目顺序 × BOT_GROUP_ORDER，最后是「其他本机会话」）排列 */
  const botGroupKeysInOrder = useCallback(() => {
    const keys: string[] = [];
    for (const project of projects) {
      const list = sessionsByProject[project.id] ?? [];
      for (const botType of BOT_GROUP_ORDER) {
        if (list.some((s) => s.agentType === botType)) keys.push(`${project.id}::${botType}`);
      }
    }
    // 「其他本机会话」按其展示顺序（OTHER_GROUP_LABELS 键序）追加
    for (const botType of Object.keys(OTHER_GROUP_LABELS) as AgentType[]) {
      if (otherLocalSessions.some((s) => s.agentType === botType)) keys.push(`other::${botType}`);
    }
    return keys;
  }, [projects, sessionsByProject, otherLocalSessions]);

  /** 全部折叠：把所有存在的机器人分组 key 都加入折叠集合 */
  const handleCollapseAllBotGroups = () => {
    setCollapsedBotGroups(new Set(botGroupKeysInOrder()));
  };
  /** 全部展开：清空折叠集合 */
  const handleExpandAllBotGroups = () => {
    setCollapsedBotGroups(new Set());
  };
  /** 逐层展开：每次按展示顺序展开一个仍折叠的机器人分组 */
  const handleExpandNextBotGroup = () => {
    const next = botGroupKeysInOrder().find((key) => collapsedBotGroups.has(key));
    if (!next) return;
    setCollapsedBotGroups((prev) => {
      const nextSet = new Set(prev);
      nextSet.delete(next);
      return nextSet;
    });
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

  const allVisibleSessions = [...Object.values(sessionsByProject).flat(), ...otherLocalSessions];
  const sessionQueryTrim = sessionQuery.trim().toLowerCase();
  const searchResults = sessionQueryTrim
    ? allVisibleSessions.filter((s) =>
        s.title.toLowerCase().includes(sessionQueryTrim) ||
        (s.cwd || "").toLowerCase().includes(sessionQueryTrim))
    : null;
  const selectedSession = selectedSessionId
    ? allVisibleSessions.find((session) => session.id === selectedSessionId)
    : undefined;
  const selectedSessionTitle = selectedSession?.title;

  const [sidebarWidth, setSidebarWidth] = useState(260);
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
    document.removeEventListener("mousemove", handleDrag);
    document.removeEventListener("mouseup", stopDrag);
  }, [handleDrag]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    isDragging.current = true;
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

  const applySessionIndex = (list: Session[], projectList: Project[] = projects) => {
    const rootMap: Record<string, Session[]> = Object.fromEntries(projectList.map((project) => [project.id, []]));
    const childMap: Record<string, Session[]> = {};
    const unmatched: Session[] = [];
    for (const session of list) {
      if (session.parentSessionId) {
        (childMap[session.parentSessionId] ??= []).push(session);
      } else if (session.projectId && rootMap[session.projectId]) {
        rootMap[session.projectId].push(session);
      } else {
        unmatched.push(session);
      }
    }
    for (const sessions of Object.values(rootMap)) {
      sessions.sort((a, b) => b.updated.localeCompare(a.updated));
    }
    for (const sessions of Object.values(childMap)) {
      sessions.sort((a, b) => a.created.localeCompare(b.created));
    }
    unmatched.sort((a, b) => b.updated.localeCompare(a.updated));
    setSessionsByProject(rootMap);
    setChildSessionsByParent(childMap);
    setOtherLocalSessions(unmatched);
  };

const loadProjects = async () => {
    if (!window.agentApi) return;
    const list = await window.agentApi.listProjects() as Project[];
    setProjects(list);
    // Check which project paths still exist on disk
    const invalid = new Set<string>();
    await Promise.all(list.map(async (p) => {
      if (p.description && !(await window.agentApi!.checkProjectPath(p.description))) {
        invalid.add(p.id);
      }
    }));
    setInvalidProjectIds(invalid);
    const sessions = await window.agentApi.refreshSessions() as Session[];
    applySessionIndex(sessions, list);
  };

  const loadSessions = async (projectId?: string) => {
    if (!window.agentApi) return;
    if (!projectId) return;
    const list = await window.agentApi.listSessions(projectId) as Session[];
    // Separate root sessions (no parent) from child sessions
    const roots = list.filter((s) => !s.parentSessionId);
    setSessionsByProject((prev) => ({ ...prev, [projectId]: roots }));

    // Build fresh child groups — replacing, not appending, so deleted children are removed
    const freshChildGroups: Record<string, Session[]> = {};
    for (const child of list.filter((s) => s.parentSessionId)) {
      const pid = child.parentSessionId!;
      (freshChildGroups[pid] ??= []).push(child);
    }
    for (const kids of Object.values(freshChildGroups)) {
      kids.sort((a, b) => (a.created < b.created ? -1 : 1));
    }
    setChildSessionsByParent((prev) => {
      const next = { ...prev };
      for (const root of roots) {
        if (freshChildGroups[root.id]) {
          next[root.id] = freshChildGroups[root.id];
        } else {
          delete next[root.id]; // root has no children (or they were deleted)
        }
      }
      return next;
    });
  };

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
    // the first turn runs, so insert the created session optimistically under
    // "其他本机会话" to keep the selection resolvable.
    setOtherLocalSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
    setOtherLocalExpanded(true);
    setSelectedProjectId(null);
    setSelectedSessionId(created.id);
    if (mobileDrawer) setSidebarDrawerOpen(false);
  };

  /** New session from a directory row under 其他本机会话: defaults to the
   *  group's agent. Native runtimes take the directory as cwd; customer-agent
   *  sessions reuse the slug label as projectId so they stay in the folder. */
  const handleNewGroupSession = async (agentType: AgentType, dirKey: string, collapseKey?: string) => {
    if (!window.agentApi) return;
    const isCustomerAgent = agentType === "customer-agent";
    try {
      const created = await window.agentApi.createSession(
        "新会话",
        isCustomerAgent ? dirKey : undefined,
        agentType,
        isCustomerAgent ? undefined : dirKey,
      ) as Session;
      setOtherLocalSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
      setOtherLocalExpanded(true);
      if (collapseKey) {
        setCollapsedDirs((prev) => {
          if (!prev.has(collapseKey)) return prev;
          const next = new Set(prev);
          next.delete(collapseKey);
          return next;
        });
      }
      setSelectedProjectId(null);
      setSelectedSessionId(created.id);
      if (mobileDrawer) setSidebarDrawerOpen(false);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "新建会话失败");
      setNoticeType("error");
      setTimeout(() => setNotice(null), 4000);
    }
  };

  useEffect(() => {
    const bootstrap = async () => {
      if (!window.agentApi) return;
      // Load settings on startup so isConfigured is correct
      await useSettingsStore.getState().loadFromSystem();
      const list = await window.agentApi.listProjects() as Project[];
      setProjects(list);

      const allSessions = await window.agentApi.listSessions() as Session[];
      const rootMap: Record<string, Session[]> = Object.fromEntries(list.map((project) => [project.id, []]));
      const childMap: Record<string, Session[]> = {};
      const unmatched: Session[] = [];
      for (const current of allSessions) {
        if (current.parentSessionId) {
          (childMap[current.parentSessionId] ??= []).push(current);
        } else if (current.projectId && rootMap[current.projectId]) {
          rootMap[current.projectId].push(current);
        } else {
          unmatched.push(current);
        }
      }
      for (const kids of Object.values(childMap)) kids.sort((a, b) => a.created.localeCompare(b.created));
      setSessionsByProject(rootMap);
      setChildSessionsByParent(childMap);
      setOtherLocalSessions(unmatched.sort((a, b) => b.updated.localeCompare(a.updated)));
      setRuntimeHealth(await window.agentApi.getRuntimeHealth());

      // Auto-select: project + most recently updated ROOT session (never a child session)
      const allRoots = Object.entries(rootMap).flatMap(([pid, ss]) =>
        ss.map((s) => ({ ...s, _pid: pid }))
      );
      const latest = allRoots.sort((a, b) => (b.updated > a.updated ? 1 : -1))[0];
      if (latest) {
        setSelectedProjectId(latest._pid);
        setSelectedSessionId(latest.id);
        setExpandedProjects(new Set([latest._pid]));
      } else if (unmatched.length > 0) {
        setSelectedProjectId(null);
        setSelectedSessionId(unmatched[0].id);
        setOtherLocalExpanded(true);
      } else if (list.length > 0) {
        setSelectedProjectId(list[0].id);
        setExpandedProjects(new Set([list[0].id]));
      }
    };
    void bootstrap();
  }, []);

  useEffect(() => {
    if (!selectedSessionId || selectedSession?.agentType === "customer-agent" || !window.agentApi) return;
    let cancelled = false;
    const refresh = async () => {
      if (document.visibilityState !== "visible") return;
      const sessions = await window.agentApi!.refreshSessions() as Session[];
      if (!cancelled) applySessionIndex(sessions);
    };
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // Session identity and project registration are the only inputs relevant
    // to native ownership polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, selectedSession?.agentType, projects]);

  // Sync working directory whenever the selected project changes (covers startup,
  // session click, new session, and explicit project click).
  useEffect(() => {
    if (!selectedProjectId || !window.agentApi) return;
    const proj = projects.find((p) => p.id === selectedProjectId);
    const path = proj?.description;
    if (path) void window.agentApi.setProjectWorkingDir(path);
  }, [selectedProjectId, projects]);

  const handleSelectProject = async (projectId: string | null) => {
    setSelectedProjectId(projectId);
    setSelectedSessionId(null);
    if (projectId) {
      await loadSessions(projectId);
    }
  };

  /** Toggle expand/collapse for a project; also selects it if switching from another project */
  const handleToggleProject = async (projectId: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
      return next;
    });
    if (selectedProjectId !== projectId) {
      setSelectedProjectId(projectId);
      setSelectedSessionId(null);
      await loadSessions(projectId);
    }
  };

  const handleImportProject = async () => {
    try {
      if (!window.agentApi) {
        setNotice("agentApi 未就绪，请重启应用");
        setNoticeType("error");
        return;
      }
      const selectedPath = await window.agentApi.openFileDialog();
      console.log("[import] selectedPath:", selectedPath);
      if (!selectedPath) return;
      const normalizedPath = selectedPath.replace(/\\/g, "/");
      const segments = normalizedPath.split("/").filter(Boolean);
      const name = segments[segments.length - 1] || "导入的项目";
      const created = await window.agentApi.createProject(name, normalizedPath) as Project;
      await loadProjects();
      setSelectedProjectId(created.id);
      setSelectedSessionId(null);
      await loadSessions(created.id);
      setExpandedProjects((prev) => { const n = new Set(prev); n.add(created.id); return n; });
      // setProjectWorkingDir is handled by the selectedProjectId effect
      setNotice(`已导入：${name}`);
      setNoticeType("success");
      setTimeout(() => setNotice(null), 3000);
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
          padding: "0 20px 20px",
          borderBottom: "1px solid var(--border-subtle)",
          marginBottom: 16,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: "var(--accent)",
              display: "flex", alignItems: "center", justifyContent: "center",
              flexShrink: 0,
            }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>
              </svg>
            </div>
            <span style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text-primary)",
              letterSpacing: "-0.01em",
            }}>智能助手</span>
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              title="搜索会话"
              aria-label="搜索会话"
              className="ui-icon-button ui-icon-button--small"
              style={{ marginLeft: "auto", color: "var(--text-muted)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setRunningFirst(!runningFirst)}
              title="进行中的会话排在最前"
              aria-label="进行中的会话排在最前"
              aria-pressed={runningFirst}
              className={`ui-icon-button ui-icon-button--small${runningFirst ? " is-active" : ""}`}
              style={runningFirst ? undefined : { color: "var(--text-muted)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => setGroupByBot(!groupByBot)}
              title="会话按机器人分组"
              aria-label="会话按机器人分组"
              aria-pressed={groupByBot}
              className={`ui-icon-button ui-icon-button--small${groupByBot ? " is-active" : ""}`}
              style={groupByBot ? undefined : { color: "var(--text-muted)" }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="5" y="9" width="14" height="10" rx="2" />
                <path d="M12 9V6" /><circle cx="12" cy="4" r="1.6" />
                <path d="M9.5 13v1.6M14.5 13v1.6" />
              </svg>
            </button>
          </div>
        </div>

        {/* 机器人分组批量操作：仅在开启分组时显示 */}
        {groupByBot && (
          <div style={{ display: "flex", gap: 4, padding: "0 14px 10px", justifyContent: "flex-end" }}>
            {([
              ["全部折叠", handleCollapseAllBotGroups, "折叠所有机器人的会话组"],
              ["逐层展开", handleExpandNextBotGroup, "每次展开一个机器人分组"],
              ["全部展开", handleExpandAllBotGroups, "展开所有机器人分组"],
            ] as const).map(([label, handler, tip]) => (
              <button
                key={label}
                type="button"
                onClick={handler}
                title={tip}
                aria-label={tip}
                style={{
                  padding: "3px 8px",
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 6,
                  background: "transparent",
                  color: "var(--text-muted)",
                  fontSize: 10,
                  lineHeight: 1.4,
                  cursor: "pointer",
                  transition: "color 0.15s, border-color 0.15s",
                }}
              >{label}</button>
            ))}
          </div>
        )}

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

        {/* Section label */}
        <div className="app-sidebar-section" style={{ padding: "0 20px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{
            fontSize: 10,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 600,
          }}>项目</span>
          {!webShell && (
          <button
            onClick={() => void handleImportProject()}
            title="导入项目"
            aria-label="导入项目"
            className="ui-icon-button ui-icon-button--small sidebar-row-action"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          )}
        </div>

        {/* Project + session list */}
        <div className="app-sidebar-scroll" style={{ flex: 1, overflow: "auto", padding: "0 10px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 }}>
            {projects.map((project) => {
              const isSelected = selectedProjectId === project.id && !selectedSessionId;
              const isExpanded = expandedProjects.has(project.id);
              const projectSessions = sessionsByProject[project.id] ?? [];
              const projSessions = runningFirst ? runningFirstSort(projectSessions, isSessionRunning) : projectSessions;
              const manySession = projSessions.length > 10;
              const isInvalid = invalidProjectIds.has(project.id);
              return (
                <div key={project.id}>
                  {/* Project row */}
                  <div
                    className={`sidebar-row ${isSelected && !isInvalid ? "sidebar-row-active" : ""}`}
                    style={{ paddingRight: 4, opacity: isInvalid ? 0.45 : 1 }}
                  >
                    <button
                      onClick={() => { if (!isInvalid) void handleToggleProject(project.id); }}
                      disabled={isInvalid}
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
                      {/* chevron + folder icon */}
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                        style={{ flexShrink: 0, opacity: isSelected && !isInvalid ? 0.8 : 0.4, transform: isExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.2s ease" }}>
                        <path d="M6 9l6 6 6-6"/>
                      </svg>
                      {isInvalid ? (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                      ) : (
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: isSelected ? 1 : 0.5 }}>
                          {isExpanded
                            ? <><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="14" x2="15" y2="14"/></>
                            : <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>}
                        </svg>
                      )}
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {project.name}
                      </span>
                      {projSessions.length > 0 && (
                        <span className="sidebar-count" style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, color: isSelected && !isInvalid ? "var(--accent)" : "var(--text-muted)", background: isSelected && !isInvalid ? "var(--accent-dim)" : "var(--bg-deep)", borderRadius: 8, padding: "0 5px", lineHeight: "15px", opacity: 0.8 }}>{projSessions.length}</span>
                      )}
                    </button>
                    {/* Delete project button */}
                    <button
                      onClick={(e) => { e.stopPropagation(); void handleDeleteProject(project.id); }}
                      title="删除项目"
                      className="sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                      style={{
                        flexShrink: 0,
                        fontSize: 14,
                        lineHeight: 1,
                      }}
                    >×</button>
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
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 2, paddingLeft: 10, paddingBottom: 4, ...(manySession ? { maxHeight: 280, overflowY: "auto" as const } : {}) }}>
                      {(() => {
                        const renderSession = (session: Session) => {
                        const isActiveSession = selectedSessionId === session.id;
                        const children = childSessionsByParent[session.id] ?? [];
                        return (
                          <div key={session.id}>
                          <div className={`sidebar-row ${isActiveSession ? "sidebar-row-active" : ""}`} style={{ paddingRight: 4 }}>
                            <button
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
                              <span style={{
                                width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                                background: isActiveSession ? "var(--accent)" : isSessionRunning(session) ? "var(--accent)" : (session.status === "completed" ? "var(--success)" : "var(--border-default)"),
                                transition: "background 0.15s",
                              }} />
                              <span title={session.sourceLabel} style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {session.title}
                              </span>
                              {session.occupancy === "owned-externally" && (
                                <span title="原客户端正在使用，只读" aria-label="只读" style={{ flexShrink: 0, display: "flex" }}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                    <rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>
                                  </svg>
                                </span>
                              )}
                              {children.length > 0 && (
                                <span className="sidebar-count" style={{
                                  flexShrink: 0, fontSize: 9, fontWeight: 600,
                                  color: isActiveSession ? "var(--accent)" : "var(--text-muted)",
                                  background: isActiveSession ? "var(--accent-dim)" : "var(--bg-deep)",
                                  borderRadius: 8, padding: "0 5px", lineHeight: "16px",
                                  opacity: 0.8,
                                }}>{children.length}</span>
                              )}
                            </button>
                            {session.canDelete && <button
                              onClick={() => void handleDeleteSession(session.id)}
                              title="删除会话"
                              className="sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                              style={{
                                fontSize: 14, flexShrink: 0,
                                lineHeight: 1,
                              }}
                            >×</button>}
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
                                  className="sidebar-row-action ui-icon-button ui-icon-button--small ui-icon-button--danger"
                                  style={{
                                    fontSize: 12, flexShrink: 0, lineHeight: 1,
                                  }}
                                >×</button>
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
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.55 }} aria-hidden="true">
                                    <rect x="5" y="9" width="14" height="10" rx="2" />
                                    <path d="M12 9V6" /><circle cx="12" cy="4" r="1.6" />
                                    <path d="M9.5 13v1.6M14.5 13v1.6" />
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
                      {projSessions.length === 0 && (
                        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: "4px 10px", opacity: 0.7 }}>
                          暂无会话
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            {otherLocalSessions.length > 0 && (
              <div style={{ marginTop: 8, borderTop: "1px solid var(--border-subtle)", paddingTop: 7 }}>
                <button
                  type="button"
                  onClick={() => setOtherLocalExpanded((expanded) => !expanded)}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 7,
                    padding: "7px 10px",
                    border: 0,
                    background: "transparent",
                    color: "var(--text-muted)",
                    fontSize: 11,
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" style={{ transform: otherLocalExpanded ? "rotate(0deg)" : "rotate(-90deg)" }}>
                    <path d="M6 9l6 6 6-6"/>
                  </svg>
                  <span style={{ flex: 1 }}>其他本机会话</span>
                  <span className="sidebar-count" style={{ fontSize: 9, padding: "0 5px", borderRadius: 8, background: "var(--bg-deep)" }}>{otherLocalSessions.length}</span>
                </button>
                {otherLocalExpanded && (
                  <div style={{ maxHeight: 340, overflowY: "auto", paddingLeft: 10 }}>
                    {(Object.keys(OTHER_GROUP_LABELS) as AgentType[]).map((groupType) => {
                      const group = otherLocalSessions.filter((s) => s.agentType === groupType);
                      if (group.length === 0) return null;
                      const subGroups: Array<[string, string, Session[]]> = [];
                      for (const session of group) {
                        const { label, full } = otherSessionGroup(
                          session,
                          projects.find((p) => p.id === session.projectId)?.name,
                        );
                        const bucket = subGroups.find(([name]) => name === label);
                        if (bucket) bucket[2].push(session); else subGroups.push([label, full, [session]]);
                      }
                      subGroups.sort((a, b) =>
                        (runningFirst ? Number(b[2].some(isSessionRunning)) - Number(a[2].some(isSessionRunning)) : 0) ||
                        b[2].length - a[2].length ||
                        a[0].localeCompare(b[0]));
                      const otherBotKey = `other::${groupType}`;
                      const botExpanded = !collapsedBotGroups.has(otherBotKey);
                      return (
                        <div key={groupType}>
                          <button
                            type="button"
                            onClick={() => setCollapsedBotGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(otherBotKey)) next.delete(otherBotKey); else next.add(otherBotKey);
                              return next;
                            })}
                            aria-expanded={botExpanded}
                            title={OTHER_GROUP_LABELS[groupType]}
                            style={{
                              width: "100%",
                              display: "flex",
                              alignItems: "center",
                              gap: 8,
                              padding: "7px 10px 3px",
                              border: 0,
                              background: "transparent",
                              color: "var(--text-muted)",
                              cursor: "pointer",
                              textAlign: "left" as const,
                            }}
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                              style={{ flexShrink: 0, opacity: 0.4, transform: botExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.2s ease" }} aria-hidden="true">
                              <path d="M6 9l6 6 6-6"/>
                            </svg>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.55 }} aria-hidden="true">
                              <rect x="5" y="9" width="14" height="10" rx="2"/>
                              <path d="M12 9V6"/><circle cx="12" cy="4" r="1.6"/>
                              <path d="M9.5 13v1.6M14.5 13v1.6"/>
                            </svg>
                            <span style={{
                              flex: 1,
                              fontSize: 9,
                              fontWeight: 700,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                            }}>{OTHER_GROUP_LABELS[groupType]}</span>
                            <span className="sidebar-count" style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, background: "var(--bg-deep)", borderRadius: 8, padding: "0 5px", lineHeight: "15px", opacity: 0.8 }}>{group.length}</span>
                          </button>
                          {botExpanded && subGroups.map(([projectName, full, sessions]) => {
                            const dirKey = `${groupType}::${projectName}`;
                            const dirExpanded = !collapsedDirs.has(dirKey);
                            const manyDirSessions = sessions.length > 10;
                            return (
                            <div key={projectName}>
                              <div className="sidebar-row" style={{ paddingRight: 4 }}>
                                <button
                                  type="button"
                                  onClick={() => setCollapsedDirs((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(dirKey)) next.delete(dirKey); else next.add(dirKey);
                                    return next;
                                  })}
                                  title={full || undefined}
                                  aria-expanded={dirExpanded}
                                  style={{
                                    flex: 1,
                                    minWidth: 0,
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    padding: "5px 10px 5px 14px",
                                    border: 0,
                                    background: "transparent",
                                    color: "var(--text-muted)",
                                    fontSize: 11,
                                    fontWeight: 600,
                                    cursor: "pointer",
                                    textAlign: "left",
                                  }}
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                                    style={{ flexShrink: 0, opacity: 0.4, transform: dirExpanded ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 0.2s ease" }} aria-hidden="true">
                                    <path d="M6 9l6 6 6-6"/>
                                  </svg>
                                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.5 }} aria-hidden="true">
                                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                                  </svg>
                                  <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{projectName}</span>
                                  <span className="sidebar-count" style={{ flexShrink: 0, fontSize: 9, fontWeight: 600, color: "var(--text-muted)", background: "var(--bg-deep)", borderRadius: 8, padding: "0 5px", lineHeight: "15px", opacity: 0.8 }}>{sessions.length}</span>
                                </button>
                                {!webShell && full && (
                                  <button
                                    type="button"
                                    onClick={() => void handleNewGroupSession(groupType, full, dirKey)}
                                    title="新建会话"
                                    aria-label={`在 ${projectName} 新建会话`}
                                    className="sidebar-row-action sidebar-row-action--accent ui-icon-button ui-icon-button--small"
                                    style={{ fontSize: 16, lineHeight: 1, flexShrink: 0 }}
                                  >+</button>
                                )}
                              </div>
                              <div style={{
                                overflow: "hidden",
                                maxHeight: dirExpanded ? (manyDirSessions ? 300 : sessions.length * 34 + 8) : 0,
                                opacity: dirExpanded ? 1 : 0,
                                transition: "max-height 0.45s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease",
                              }}>
                                <div style={manyDirSessions ? { maxHeight: 280, overflowY: "auto" as const } : undefined}>
                                {(runningFirst ? runningFirstSort(sessions, isSessionRunning) : sessions).map((session) => {
                                  const active = selectedSessionId === session.id;
                                  const tooltip = [session.sourceLabel, session.cwd].filter(Boolean).join("\n");
                                  return (
                                    <div key={session.id} className={`sidebar-row ${active ? "sidebar-row-active" : ""}`}>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setSelectedProjectId(null);
                                          setSelectedSessionId(session.id);
                                          if (mobileDrawer) setSidebarDrawerOpen(false);
                                        }}
                                        title={tooltip || undefined}
                                        style={{
                                          flex: 1,
                                          minWidth: 0,
                                          display: "flex",
                                          alignItems: "center",
                                          gap: 7,
                                          padding: "6px 10px 6px 22px",
                                          border: 0,
                                          background: "transparent",
                                          color: active ? "var(--accent)" : "var(--text-secondary)",
                                          fontSize: 12,
                                          cursor: "pointer",
                                          textAlign: "left",
                                        }}
                                      >
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
                                </div>
                              </div>
                            </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
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
        onMouseDown={startDrag}
        style={{
          width: 4,
          flexShrink: 0,
          cursor: "col-resize",
          zIndex: 15,
          background: "transparent",
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--accent)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      />
      )}

      {searchOpen && (
        <div
          onClick={() => setSearchOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
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
              {!sessionQueryTrim && (
                <div style={{ color: "var(--text-muted)", fontSize: 12, padding: "16px 10px", textAlign: "center", opacity: 0.7 }}>
                  输入关键词搜索会话标题或工作目录
                </div>
              )}
              {searchResults?.map((session) => {
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
            </div>
          </div>
        </div>
      )}
      </>
      )}

      <main className="app-main" style={{
        flex: 1,
        overflow: "hidden",
        background: "var(--bg-deepest)",
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
              await loadSessions(selectedProjectId || undefined);
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
              if (window.agentApi) {
                const sessions = await window.agentApi.refreshSessions() as Session[];
                applySessionIndex(sessions);
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
