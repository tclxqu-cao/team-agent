import { useState, useEffect } from "react";
import type { MCPServer } from "../global";

type Transport = "stdio" | "sse";

const EMPTY_LOCAL = { id: "", name: "", command: "", args: "" };
const EMPTY_REMOTE = { id: "", name: "", url: "" };

export default function MCPServerList() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [transport, setTransport] = useState<Transport>("stdio");
  const [localForm, setLocalForm] = useState(EMPTY_LOCAL);
  const [remoteForm, setRemoteForm] = useState(EMPTY_REMOTE);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState({ id: false, command: false, url: false });

  useEffect(() => {
    if (!window.agentApi) return;
    window.agentApi.mcpList().then(setServers).catch(console.error);
  }, []);

  const isLocalValid = () => localForm.id.trim() !== "" && localForm.command.trim() !== "";
  const isRemoteValid = () => remoteForm.id.trim() !== "" && remoteForm.url.trim() !== "";

  const addServer = async () => {
    setTouched({ id: true, command: true, url: true });
    if (transport === "stdio" && !isLocalValid()) return;
    if (transport === "sse" && !isRemoteValid()) return;
    setSaving(true);
    try {
      const server: MCPServer = transport === "stdio"
        ? { id: localForm.id, name: localForm.name || localForm.id, transport: "stdio", command: localForm.command, args: localForm.args.split(" ").filter(Boolean), enabled: true }
        : { id: remoteForm.id, name: remoteForm.name || remoteForm.id, transport: "sse", url: remoteForm.url, enabled: true };
      await window.agentApi.mcpSave(server);
      const updated = await window.agentApi.mcpList();
      setServers(updated);
      setLocalForm(EMPTY_LOCAL);
      setRemoteForm(EMPTY_REMOTE);
      setTouched({ id: false, command: false, url: false });
    } catch (e) {
      console.error("Failed to save MCP server", e);
    } finally {
      setSaving(false);
    }
  };

  const removeServer = async (id: string) => {
    await window.agentApi.mcpDelete(id);
    setServers(servers.filter((s) => s.id !== id));
  };

  const toggleEnabled = async (id: string, enabled: boolean) => {
    await window.agentApi.mcpSetEnabled(id, enabled);
    setServers(servers.map((s) => s.id === id ? { ...s, enabled } : s));
  };

  const idVal = transport === "stdio" ? localForm.id : remoteForm.id;
  const setId = (v: string) => transport === "stdio" ? setLocalForm(f => ({ ...f, id: v })) : setRemoteForm(f => ({ ...f, id: v }));
  const nameVal = transport === "stdio" ? localForm.name : remoteForm.name;
  const setName = (v: string) => transport === "stdio" ? setLocalForm(f => ({ ...f, name: v })) : setRemoteForm(f => ({ ...f, name: v }));

  return (
    <div style={{ padding: "40px 48px", maxWidth: 660, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      <h2 style={{ fontFamily: "var(--font-display)", fontSize: 28, color: "var(--text-primary)", fontWeight: 400, marginBottom: 8, letterSpacing: "-0.02em" }}>
        MCP 服务器
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 32 }}>
        通过模型上下文协议连接外部工具。
      </p>

      {/* Add form */}
      <div style={{
        padding: 20,
        background: "var(--bg-glass)",
        borderRadius: "var(--radius-md)",
        border: "1px solid var(--border-subtle)",
        marginBottom: 28,
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
      }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>添加服务器</h3>
          {/* Transport toggle */}
          <div style={{ display: "flex", background: "var(--bg-surface)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-default)", overflow: "hidden" }}>
            {(["stdio", "sse"] as Transport[]).map((t) => (
              <button key={t} onClick={() => { setTransport(t); setTouched({ id: false, command: false, url: false }); }} style={{
                padding: "5px 14px", border: "none", fontSize: 12, fontWeight: 500, cursor: "pointer",
                fontFamily: "var(--font-body)", transition: "background 0.15s",
                background: transport === t ? "var(--accent)" : "transparent",
                color: transport === t ? "var(--text-inverse)" : "var(--text-muted)",
              }}>
                {t === "stdio" ? "本地 stdio" : "远程 SSE"}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Common: ID + Name */}
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <input value={idVal} onChange={(e) => setId(e.target.value)} onBlur={() => setTouched(t => ({ ...t, id: true }))} placeholder="服务器 ID *" style={{ ...inputStyle, ...(touched.id && !idVal ? errorInputStyle : {}) }} />
              {touched.id && !idVal && <span style={{ fontSize: 11, color: "var(--danger)" }}>必填</span>}
            </div>
            <input value={nameVal} onChange={(e) => setName(e.target.value)} placeholder="显示名称" style={{ ...inputStyle, flex: 1 }} />
          </div>

          {transport === "stdio" ? (
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                <input value={localForm.command} onChange={(e) => setLocalForm(f => ({ ...f, command: e.target.value }))} onBlur={() => setTouched(t => ({ ...t, command: true }))} placeholder="命令（如 npx）*" style={{ ...inputStyle, ...(touched.command && !localForm.command ? errorInputStyle : {}) }} />
                {touched.command && !localForm.command && <span style={{ fontSize: 11, color: "var(--danger)" }}>必填</span>}
              </div>
              <input value={localForm.args} onChange={(e) => setLocalForm(f => ({ ...f, args: e.target.value }))} placeholder="参数（如 -y @anthropic/mcp-server）" style={{ ...inputStyle, flex: 2 }} />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <input value={remoteForm.url} onChange={(e) => setRemoteForm(f => ({ ...f, url: e.target.value }))} onBlur={() => setTouched(t => ({ ...t, url: true }))} placeholder="服务器 URL（如 https://mcp.example.com/sse）*" style={{ ...inputStyle, ...(touched.url && !remoteForm.url ? errorInputStyle : {}) }} />
              {touched.url && !remoteForm.url && <span style={{ fontSize: 11, color: "var(--danger)" }}>必填</span>}
            </div>
          )}

          <button onClick={addServer} disabled={saving} style={{
            alignSelf: "flex-start",
            padding: "10px 22px",
            borderRadius: "var(--radius-sm)",
            border: "none",
            background: "var(--accent)",
            color: "var(--text-inverse)",
            fontSize: 13,
            fontWeight: 600,
            cursor: saving ? "not-allowed" : "pointer",
            fontFamily: "var(--font-body)",
          }}>
            {saving ? "保存中…" : "添加服务器"}
          </button>
        </div>
      </div>

      {/* Server cards */}
      {servers.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 14, padding: "40px 0", textAlign: "center" }}>
          暂无 MCP 服务器，点击上方添加。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {servers.map((s) => (
            <div key={s.id} style={{
              padding: "14px 16px",
              background: "var(--bg-glass)",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-subtle)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              backdropFilter: "blur(12px)",
              WebkitBackdropFilter: "blur(12px)",
              transition: "border-color 0.2s",
            }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                    {s.name || s.id}
                  </div>
                  <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: s.transport === "sse" ? "rgba(99,179,237,0.15)" : "rgba(154,230,180,0.15)", color: s.transport === "sse" ? "#63b3ed" : "#68d391", fontWeight: 600 }}>
                    {s.transport === "sse" ? "远程" : "本地"}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                  {s.transport === "sse" ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <label style={{ fontSize: 12, color: "var(--text-muted)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                  <input
                    type="checkbox"
                    checked={s.enabled !== false}
                    onChange={(e) => toggleEnabled(s.id, e.target.checked)}
                    style={{ cursor: "pointer" }}
                  />
                  启用
                </label>
              <button
                onClick={() => removeServer(s.id)}
                style={{
                  padding: "5px 12px", borderRadius: "var(--radius-sm)",
                  border: "1px solid rgba(248,113,113,0.2)", background: "transparent",
                  color: "var(--danger)", fontSize: 12, cursor: "pointer",
                  fontFamily: "var(--font-body)", fontWeight: 500,
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(248,113,113,0.1)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                移除
              </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
  fontFamily: "var(--font-body)",
};

const errorInputStyle: React.CSSProperties = {
  border: "1px solid var(--danger)",
  boxShadow: "0 0 0 2px rgba(248,113,113,0.15)",
};