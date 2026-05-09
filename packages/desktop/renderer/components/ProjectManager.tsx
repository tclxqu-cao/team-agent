import { useEffect, useState } from "react";

interface Project { id: string; name: string; description: string; created: string; updated: string; }
interface Session { id: string; projectId: string; title: string; status: string; created: string; updated: string; }

export default function ProjectManager() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "error">("success");

  const loadProjects = async () => {
    if (window.agentApi) { const list = await window.agentApi.listProjects(); setProjects(list as Project[]); }
  };

  const loadSessions = async (projectId?: string) => {
    if (window.agentApi) { const list = await window.agentApi.listSessions(projectId || undefined); setSessions(list as Session[]); }
  };

  useEffect(() => { loadProjects(); loadSessions(); }, []);

  const handleSelectProject = (id: string) => {
    setSelectedProject(id);
    loadSessions(id || undefined);
  };

  const handleCreateProject = async () => {
    if (!name.trim() || !window.agentApi) return;
    try {
      await window.agentApi.createProject(name.trim(), description.trim());
      setName(""); setDescription(""); setShowNew(false);
      setNotice("项目创建成功");
      setNoticeType("success");
      await loadProjects();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "项目创建失败");
      setNoticeType("error");
    }
  };

  const handleDeleteProject = async (id: string) => {
    if (!window.agentApi) return;
    try {
      await window.agentApi.deleteProject(id);
      if (selectedProject === id) { setSelectedProject(""); await loadSessions(); }
      setNotice("项目删除成功");
      setNoticeType("success");
      await loadProjects();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "项目删除失败");
      setNoticeType("error");
    }
  };

  const handleDeleteSession = async (id: string) => {
    if (!window.agentApi) return;
    try {
      await window.agentApi.deleteSession(id);
      setNotice("会话删除成功");
      setNoticeType("success");
      await loadSessions(selectedProject || undefined);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "会话删除失败");
      setNoticeType("error");
    }
  };

  return (
    <div style={{ padding: "40px 48px", maxWidth: 780, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--text-primary)", fontWeight: 400, letterSpacing: "-0.02em", marginBottom: 8 }}>
        Projects
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 28 }}>
        Organize sessions by project.
      </p>

      {notice && (
        <div style={{
          padding: "10px 12px",
          borderRadius: "var(--radius-sm)",
          border: noticeType === "success"
            ? "1px solid rgba(52,211,153,0.35)"
            : "1px solid rgba(244,63,94,0.35)",
          background: noticeType === "success"
            ? "rgba(52,211,153,0.08)"
            : "rgba(244,63,94,0.08)",
          color: noticeType === "success" ? "var(--success)" : "var(--danger)",
          fontSize: 13,
          marginBottom: 16,
        }}>
          {notice}
        </div>
      )}

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 10, marginBottom: 28 }}>
        <select
          value={selectedProject}
          onChange={(e) => handleSelectProject(e.target.value)}
          style={{
            flex: 1, padding: "11px 14px", borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border-default)", background: "var(--bg-glass)",
            color: "var(--text-primary)", fontSize: 14, outline: "none",
            fontFamily: "var(--font-body)", backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        >
          <option value="">All Projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={() => setShowNew(true)} style={{
          padding: "11px 22px", borderRadius: "var(--radius-sm)", border: "none",
          background: "var(--accent)", color: "var(--text-inverse)",
          fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-body)",
          whiteSpace: "nowrap",
        }}>
          + New Project
        </button>
      </div>

      {/* New project form */}
      {showNew && (
        <div style={{
          padding: 20, marginBottom: 24, background: "var(--bg-glass)", borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-subtle)", backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" style={{ ...inputStyle, marginBottom: 10 }} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Description (optional)" style={{ ...inputStyle, marginBottom: 12 }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleCreateProject} style={{
              padding: "9px 20px", borderRadius: "var(--radius-sm)", border: "none",
              background: "var(--success)", color: "#000", fontSize: 13, fontWeight: 600,
              cursor: "pointer", fontFamily: "var(--font-body)",
            }}>Create</button>
            <button onClick={() => setShowNew(false)} style={btnSecondaryStyle}>Cancel</button>
          </div>
        </div>
      )}

      {/* Project cards */}
      <div style={{ marginBottom: 32 }}>
        {projects.filter((p) => !selectedProject || p.id === selectedProject).map((p) => (
          <div key={p.id} style={{
            padding: "14px 16px", marginBottom: 8, background: "var(--bg-glass)",
            borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)",
            backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            transition: "border-color 0.2s",
          }}>
            <div>
              <div style={{ fontWeight: 600, color: "var(--text-primary)", fontSize: 14 }}>
                {p.name}
              </div>
              {p.description && (
                <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 2 }}>{p.description}</div>
              )}
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                {new Date(p.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </div>
            </div>
            <button onClick={() => handleDeleteProject(p.id)}
              style={{ ...btnSmStyle, color: "var(--danger)" }}>
              Delete
            </button>
          </div>
        ))}
      </div>

      {/* Sessions */}
      <h3 style={{ fontSize: 15, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 14 }}>
        Sessions{selectedProject ? "" : " (all projects)"}
      </h3>

      {sessions.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 14, padding: "30px 0", textAlign: "center" }}>
          No sessions yet. Start a chat to create one.
        </div>
      ) : (
        sessions.map((s) => (
          <div key={s.id} style={{
            padding: "12px 14px", marginBottom: 6, background: "var(--bg-glass)",
            borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
            backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          }}>
            <div>
              <span style={{ color: "var(--text-primary)", fontSize: 14, fontWeight: 500 }}>{s.title}</span>
              <span style={{
                fontSize: 10, marginLeft: 8, padding: "2px 8px", borderRadius: 10,
                background: s.status === "completed" ? "rgba(52,211,153,0.1)" : "rgba(255,255,255,0.04)",
                color: s.status === "completed" ? "var(--success)" : "var(--text-muted)",
                textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500,
              }}>
                {s.status}
              </span>
            </div>
            <button onClick={() => handleDeleteSession(s.id)}
              style={{ ...btnSmStyle, color: "var(--danger)" }}>
              Del
            </button>
          </div>
        ))
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "11px 14px", borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)", background: "rgba(0,0,0,0.2)",
  color: "var(--text-primary)", fontSize: 14, outline: "none",
  fontFamily: "var(--font-body)", boxSizing: "border-box",
};

const btnSecondaryStyle: React.CSSProperties = {
  padding: "9px 16px", borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)", background: "var(--bg-glass)",
  color: "var(--text-secondary)", fontSize: 13, fontWeight: 500,
  cursor: "pointer", fontFamily: "var(--font-body)",
};

const btnSmStyle: React.CSSProperties = {
  padding: "4px 10px", borderRadius: 6, fontSize: 11,
  border: "none", background: "rgba(255,255,255,0.05)",
  color: "var(--text-secondary)", cursor: "pointer",
  fontFamily: "var(--font-body)", fontWeight: 500,
};