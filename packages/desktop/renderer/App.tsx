import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ChatView from "./components/ChatView";
import SettingsPanel from "./components/SettingsPanel";
import MCPServerList from "./components/MCPServerList";
import MemoryViewer from "./components/MemoryViewer";
import SkillManager from "./components/SkillManager";
import AgentManager from "./components/AgentManager";
import { useSettingsStore } from "./stores/settingsStore";

type SettingsTab = "settings" | "mcp" | "memory" | "skill" | "agent";

interface Project {
  id: string;
  name: string;
  description: string;
  created: string;
  updated: string;
}

interface Session {
  id: string;
  projectId: string;
  title: string;
  status: string;
  created: string;
  updated: string;
}

export default function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessionsByProject, setSessionsByProject] = useState<Record<string, Session[]>>({});
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("settings");

  const selectedSessionTitle = selectedSessionId
    ? Object.values(sessionsByProject).flat().find(s => s.id === selectedSessionId)?.title
    : undefined;

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

const loadProjects = async () => {
    if (!window.agentApi) return;
    const list = await window.agentApi.listProjects() as Project[];
    setProjects(list);
    await Promise.all(list.map((p) => loadSessions(p.id)));
  };

  const loadSessions = async (projectId?: string) => {
    if (!window.agentApi) return;
    if (!projectId) return;
    const list = await window.agentApi.listSessions(projectId);
    setSessionsByProject((prev) => ({ ...prev, [projectId]: list as Session[] }));
  };

  const handleNewSession = async (projectId: string) => {
    if (!window.agentApi) return;
    const created = await window.agentApi.createSession("新会话", projectId) as { id: string };
    await loadSessions(projectId);
    setSelectedProjectId(projectId);
    setSelectedSessionId(created.id);
  };

  useEffect(() => {
    const bootstrap = async () => {
      if (!window.agentApi) return;
      // Load settings on startup so isConfigured is correct
      await useSettingsStore.getState().loadFromSystem();
      const list = await window.agentApi.listProjects() as Project[];
      setProjects(list);
      // Load sessions for all projects
      const sessionMap: Record<string, Session[]> = {};
      await Promise.all(list.map(async (p) => {
        const sessions = await window.agentApi.listSessions(p.id) as Session[];
        sessionMap[p.id] = sessions;
      }));
      setSessionsByProject(sessionMap);

      // Auto-select: project + most recently updated session (across all projects)
      const allSessions = Object.entries(sessionMap).flatMap(([pid, ss]) =>
        ss.map((s) => ({ ...s, _pid: pid }))
      );
      const latest = allSessions.sort((a, b) => (b.updated > a.updated ? 1 : -1))[0];
      if (latest) {
        setSelectedProjectId(latest._pid);
        setSelectedSessionId(latest.id);
      } else if (list.length > 0) {
        setSelectedProjectId(list[0].id);
      }
    };
    void bootstrap();
  }, []);

  const handleSelectProject = async (projectId: string | null) => {
    setSelectedProjectId(projectId);
    setSelectedSessionId(null);
    if (projectId) {
      await loadSessions(projectId);
      const proj = projects.find((p) => p.id === projectId);
      const path = proj?.description;
      if (path && window.agentApi) {
        await window.agentApi.setProjectWorkingDir(path);
      }
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
      await window.agentApi.setProjectWorkingDir(normalizedPath);
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

  const handleDeleteSession = async (sessionId: string) => {
    if (!window.agentApi) return;
    try {
      await window.agentApi.deleteSession(sessionId);
      if (selectedSessionId === sessionId) {
        setSelectedSessionId(null);
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
  ];

  return (
    <div style={{
      display: "flex",
      height: "100vh",
      width: "100vw",
      background: "var(--bg-deepest)",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Invisible drag region across the full top — covers titlebar height */}
      <div style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        height: 52,
        zIndex: 9999,
        WebkitAppRegion: "drag",
        pointerEvents: "none",
      } as React.CSSProperties} />
      <div style={{
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

      <aside
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
        }}
      >
        {/* Logo / brand */}
        <div style={{
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

        {/* Section label */}
        <div style={{ padding: "0 20px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{
            fontSize: 10,
            color: "var(--text-muted)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            fontWeight: 600,
          }}>项目</span>
        </div>

        {/* Project + session list */}
        <div style={{ flex: 1, overflow: "auto", padding: "0 10px" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 12 }}>
            {projects.map((project) => {
              const isSelected = selectedProjectId === project.id;
              const projSessions = sessionsByProject[project.id] ?? [];
              return (
                <div key={project.id}>
                  {/* Project row */}
                  <div style={{
                    display: "flex", alignItems: "center",
                    borderRadius: 8,
                    background: isSelected ? "var(--accent-dim)" : "transparent",
                    transition: "background 0.15s",
                    paddingRight: 4,
                  }}>
                    <button
                      onClick={() => void handleSelectProject(project.id)}
                      style={{
                        flex: 1,
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                        padding: "8px 10px",
                        border: "none",
                        background: "transparent",
                        color: isSelected ? "var(--accent)" : "var(--text-secondary)",
                        fontSize: 13,
                        fontWeight: isSelected ? 600 : 400,
                        cursor: "pointer",
                        textAlign: "left" as const,
                        transition: "color 0.15s",
                      }}
                    >
                      {/* folder icon */}
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: isSelected ? 1 : 0.5 }}>
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                      </svg>
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {project.name}
                      </span>
                    </button>
                    {/* New session button */}
                    <button
                      onClick={(e) => { e.stopPropagation(); void handleNewSession(project.id); }}
                      title="新建会话"
                      style={{
                        flexShrink: 0,
                        width: 24, height: 24,
                        border: "none",
                        borderRadius: 6,
                        background: "transparent",
                        color: isSelected ? "var(--accent)" : "var(--text-muted)",
                        fontSize: 16,
                        lineHeight: 1,
                        cursor: "pointer",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        transition: "color 0.15s",
                        opacity: isSelected ? 0.8 : 0.5,
                      }}
                      onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = isSelected ? "0.8" : "0.5"; }}
                    >+</button>
                  </div>

                  {/* Sessions under this project — always rendered, height animated */}
                  <div style={{
                    overflow: "hidden",
                    maxHeight: isSelected ? 600 : 0,
                    opacity: isSelected ? 1 : 0,
                    transition: "max-height 0.55s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.4s ease",
                  }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 2, paddingLeft: 10, paddingBottom: 4 }}>
                      {projSessions.map((session) => {
                        const isActiveSession = selectedSessionId === session.id;
                        return (
                          <div key={session.id} style={{
                            display: "flex", alignItems: "center",
                            borderRadius: 7,
                            background: isActiveSession ? "rgba(79,110,247,0.08)" : "transparent",
                            transition: "background 0.15s",
                            paddingRight: 4,
                          }}>
                            <button
                              onClick={() => { setSelectedProjectId(project.id); setSelectedSessionId(session.id); }}
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
                              <span style={{
                                width: 5, height: 5, borderRadius: "50%", flexShrink: 0,
                                background: isActiveSession ? "var(--accent)" : (session.status === "completed" ? "var(--success)" : "var(--border-default)"),
                                transition: "background 0.15s",
                              }} />
                              <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                                {session.title}
                              </span>
                            </button>
                            <button
                              onClick={() => void handleDeleteSession(session.id)}
                              title="删除会话"
                              style={{
                                border: "none", background: "transparent",
                                color: isActiveSession ? "var(--accent)" : "var(--text-muted)",
                                fontSize: 14, cursor: "pointer",
                                padding: "2px 4px", flexShrink: 0, borderRadius: 4,
                                lineHeight: 1,
                                opacity: isActiveSession ? 0.7 : 0.5,
                                transition: "opacity 0.15s, color 0.15s",
                              }}
                              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.opacity = "1"; (e.currentTarget as HTMLButtonElement).style.color = "var(--danger)"; }}
                              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.opacity = isActiveSession ? "0.7" : "0.5"; (e.currentTarget as HTMLButtonElement).style.color = isActiveSession ? "var(--accent)" : "var(--text-muted)"; }}
                            >×</button>
                          </div>
                        );
                      })}
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

        {/* Import project button */}
        <div style={{ padding: "0 10px" }}>
          <button
            onClick={() => void handleImportProject()}
            style={{
              width: "100%",
              padding: "9px 12px",
              borderRadius: 8,
              border: "1px dashed var(--border-default)",
              background: "transparent",
              color: "var(--text-muted)",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
              transition: "border-color 0.15s, color 0.15s, background 0.15s",
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--accent)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--accent)";
              (e.currentTarget as HTMLButtonElement).style.background = "var(--accent-dim)";
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border-default)";
              (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14M5 12h14"/>
            </svg>
            导入项目
          </button>
        </div>
      </aside>

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

      <main style={{
        flex: 1,
        overflow: "hidden",
        background: "var(--bg-deepest)",
        position: "relative",
        zIndex: 5,
      }}>
        <div style={{ height: "100%", paddingTop: 0 }}>
          <ChatView
            selectedProjectId={selectedProjectId}
            selectedSessionId={selectedSessionId}
            sessionTitle={selectedSessionTitle}
            onOpenSettings={() => setShowSettings((prev) => !prev)}
            settingsOpen={showSettings}
            onSessionCreated={async (sessionId) => {
              setSelectedSessionId(sessionId);
              await loadSessions(selectedProjectId || undefined);
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
            onRunComplete={async (projId) => {
              if (projId || selectedProjectId) await loadSessions(projId || selectedProjectId || "");
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
                      style={{
                        padding: "6px 10px",
                        borderRadius: 7,
                        border: "none",
                        background: settingsTab === tab.id ? "var(--accent-dim)" : "transparent",
                        color: settingsTab === tab.id ? "var(--accent)" : "var(--text-secondary)",
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: "pointer",
                      }}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => setShowSettings(false)}
                  title="关闭"
                  onMouseEnter={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = "rgba(220,38,38,0.08)";
                    (e.currentTarget as HTMLButtonElement).style.color = "var(--danger)";
                  }}
                  onMouseLeave={e => {
                    (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)";
                  }}
                  style={{
                    width: 28, height: 28,
                    border: "none",
                    borderRadius: 7,
                    background: "transparent",
                    color: "var(--text-muted)",
                    fontSize: 18,
                    lineHeight: 1,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transition: "background 0.15s, color 0.15s",
                    flexShrink: 0,
                  }}
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
              </div>
            </div>
          </div>
        , document.body)}

      <div className="noise-overlay" />
    </div>
  );
}
