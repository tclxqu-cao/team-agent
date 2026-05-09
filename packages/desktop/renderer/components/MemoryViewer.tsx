import { useEffect, useState } from "react";

interface MemoryEntry {
  name: string; description: string; type: string; content: string; created: string; updated: string;
}

export default function MemoryViewer() {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<MemoryEntry | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState("user");
  const [content, setContent] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "error">("success");

  const load = async () => {
    if (window.agentApi) { const list = await window.agentApi.listMemories(); setMemories(list); }
  };

  useEffect(() => { load(); }, []);

  const handleSearch = async () => {
    if (!search.trim()) { load(); return; }
    if (window.agentApi) {
      const results = await window.agentApi.searchMemories(search);
      setMemories(results.map((r: any) => r.entry));
    }
  };

  const handleSave = async () => {
    if (!name.trim() || !window.agentApi) return;
    try {
      await window.agentApi.setMemory({
        name: name.trim(), description, type, content,
        created: editing?.created ?? new Date().toISOString(),
        updated: new Date().toISOString(),
      });
      setShowNew(false); setEditing(null);
      setName(""); setDescription(""); setContent(""); setType("user");
      setNotice("保存成功");
      setNoticeType("success");
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "保存失败");
      setNoticeType("error");
    }
  };

  const handleEdit = (m: MemoryEntry) => {
    setEditing(m); setName(m.name); setDescription(m.description);
    setType(m.type); setContent(m.content); setShowNew(true);
  };

  return (
    <div style={{ padding: "40px 48px", maxWidth: 720, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--text-primary)", fontWeight: 400, letterSpacing: "-0.02em" }}>
            记忆
          </h2>
          <p style={{ color: "var(--text-muted)", fontSize: 14, marginTop: 4 }}>
            跨会话的持久化知识库。
          </p>
        </div>
        <button onClick={() => { setShowNew(true); setEditing(null); setName(""); setDescription(""); setContent(""); setType("user"); }}
          style={{
            padding: "10px 20px", borderRadius: "var(--radius-sm)", border: "none",
            background: "var(--accent)", color: "var(--text-inverse)",
            fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "var(--font-body)",
          }}>
          + 新建
        </button>
      </div>

      {/* Search */}
      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          placeholder="搜索记忆..."
          style={{
            flex: 1, padding: "10px 14px", borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border-default)", background: "var(--bg-glass)",
            color: "var(--text-primary)", fontSize: 14, outline: "none",
            fontFamily: "var(--font-body)", backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
          }}
        />
        <button onClick={handleSearch} style={btnSecondaryStyle}>搜索</button>
      </div>

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

      {/* New/Edit form */}
      {showNew && (
        <div style={{
          padding: 20, marginBottom: 24, background: "var(--bg-glass)", borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-subtle)", backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名称" style={{ ...inputStyle, marginBottom: 10 }} disabled={!!editing} />
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="描述" style={{ ...inputStyle, marginBottom: 10 }} />
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ ...inputStyle, marginBottom: 10 }}>
            <option value="user">用户</option>
            <option value="feedback">反馈</option>
            <option value="project">项目</option>
            <option value="reference">参考</option>
          </select>
          <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="内容" rows={5} style={{ ...inputStyle, marginBottom: 12, resize: "vertical" }} />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleSave} style={{
              padding: "9px 20px", borderRadius: "var(--radius-sm)", border: "none",
              background: "var(--success)", color: "#000", fontSize: 13, fontWeight: 600,
              cursor: "pointer", fontFamily: "var(--font-body)",
            }}>保存</button>
            <button onClick={() => setShowNew(false)} style={btnSecondaryStyle}>取消</button>
          </div>
        </div>
      )}

      {/* Cards */}
      {memories.map((m) => (
        <div key={m.name} style={{
          padding: "14px 16px", marginBottom: 8, background: "var(--bg-glass)",
          borderRadius: "var(--radius-sm)", border: "1px solid var(--border-subtle)",
          backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)",
          transition: "border-color 0.2s",
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 14 }}>{m.name}</span>
              <span style={{
                fontSize: 10, padding: "2px 8px", borderRadius: 10,
                background: "rgba(255,255,255,0.04)", color: "var(--text-muted)",
                textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 500,
              }}>
                {m.type}
              </span>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={() => handleEdit(m)} style={btnSmStyle}>编辑</button>
              <button onClick={async () => {
                if (!window.agentApi) return;
                try {
                  await window.agentApi.deleteMemory(m.name);
                  setNotice("删除成功");
                  setNoticeType("success");
                  await load();
                } catch (err) {
                  setNotice(err instanceof Error ? err.message : "删除失败");
                  setNoticeType("error");
                }
              }}
                style={{ ...btnSmStyle, color: "var(--danger)" }}>删除</button>
            </div>
          </div>
          {m.description && (
            <div style={{ fontSize: 12, color: "var(--text-secondary)", marginTop: 4 }}>{m.description}</div>
          )}
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4, lineHeight: 1.5 }}>
            {m.content.slice(0, 180)}{m.content.length > 180 ? "…" : ""}
          </div>
        </div>
      ))}

      {memories.length === 0 && !showNew && (
        <div style={{ color: "var(--text-muted)", fontSize: 14, padding: "60px 0", textAlign: "center" }}>
          暂无记忆，点击「新建」创建一条。
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "11px 14px", borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)", background: "var(--bg-surface)",
  color: "var(--text-primary)", fontSize: 14, outline: "none",
  fontFamily: "var(--font-body)", boxSizing: "border-box",
};

const btnSecondaryStyle: React.CSSProperties = {
  padding: "10px 16px", borderRadius: "var(--radius-sm)",
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