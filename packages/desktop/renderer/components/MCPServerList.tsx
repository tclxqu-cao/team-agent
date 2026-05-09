import { useState } from "react";

interface MCPServer {
  id: string; name: string; command: string; args: string[]; transport: string;
}

export default function MCPServerList() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [newServer, setNewServer] = useState({ id: "", name: "", command: "", args: "" });

  const addServer = () => {
    if (!newServer.id || !newServer.command) return;
    setServers([...servers, { ...newServer, args: newServer.args.split(" ").filter(Boolean), transport: "stdio" }]);
    setNewServer({ id: "", name: "", command: "", args: "" });
  };

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
        <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 16, color: "var(--text-primary)" }}>
          添加服务器
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", gap: 10 }}>
            <input value={newServer.id} onChange={(e) => setNewServer({ ...newServer, id: e.target.value })} placeholder="服务器 ID" style={{ ...inputStyle, flex: 1 }} />
            <input value={newServer.name} onChange={(e) => setNewServer({ ...newServer, name: e.target.value })} placeholder="显示名称" style={{ ...inputStyle, flex: 1 }} />
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <input value={newServer.command} onChange={(e) => setNewServer({ ...newServer, command: e.target.value })} placeholder="命令（如 npx）" style={{ ...inputStyle, flex: 1 }} />
            <input value={newServer.args} onChange={(e) => setNewServer({ ...newServer, args: e.target.value })} placeholder="参数（如 -y @anthropic/mcp-server）" style={{ ...inputStyle, flex: 2 }} />
          </div>
          <button onClick={addServer} style={{
            alignSelf: "flex-start",
            padding: "10px 22px",
            borderRadius: "var(--radius-sm)",
            border: "none",
            background: "var(--accent)",
            color: "var(--text-inverse)",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "var(--font-body)",
          }}>
            添加服务器
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
                <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>
                  {s.name || s.id}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                  {s.command} {s.args.join(" ")}
                </div>
              </div>
              <button
                onClick={() => setServers(servers.filter((x) => x.id !== s.id))}
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