import { useState, useEffect } from "react";
import type { MCPServer } from "../global";

type Transport = "stdio" | "sse" | "streamableHttp";
type ToolInfo = { name: string; description: string };

const EMPTY_FORM = { id: "", name: "", command: "", args: "", url: "", headersRaw: "" };

export default function MCPServerList() {
  const [servers, setServers] = useState<MCPServer[]>([]);
  const [transport, setTransport] = useState<Transport>("stdio");
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState({ id: false, command: false, url: false });
  // tools per server id
  const [toolsMap, setToolsMap] = useState<Record<string, ToolInfo[]>>({});
  const [probeErrors, setProbeErrors] = useState<Record<string, string>>({});
  const [probingIds, setProbingIds] = useState<Set<string>>(new Set());
  // auth dialog
  const [authDialog, setAuthDialog] = useState<{ server: MCPServer } | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [authSaving, setAuthSaving] = useState(false);

  const probeTools = async (server: MCPServer) => {
    if (!window.agentApi?.mcpProbe) return;
    setProbingIds((prev) => new Set([...prev, server.id]));
    setProbeErrors((prev) => { const n = { ...prev }; delete n[server.id]; return n; });
    // 15s timeout so UI never gets stuck
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("连接超时（15s）")), 15000)
    );
    try {
      const tools = await Promise.race([window.agentApi.mcpProbe(server), timeout]);
      setToolsMap((prev) => ({ ...prev, [server.id]: tools }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[MCP] probe failed for ${server.id}:`, msg);
      setToolsMap((prev) => { const n = { ...prev }; delete n[server.id]; return n; });
      setProbeErrors((prev) => ({ ...prev, [server.id]: msg }));
      // auto-open auth dialog: SSE servers often need a token; also trigger on explicit auth errors
      if (server.transport === "sse" || /401|403|unauthorized|forbidden|需要认证|访问被拒绝/i.test(msg)) {
        setAuthToken("");
        setAuthDialog({ server });
      }
    } finally {
      setProbingIds((prev) => { const n = new Set(prev); n.delete(server.id); return n; });
    }
  };

  useEffect(() => {
    if (!window.agentApi) return;
    window.agentApi.mcpList().then((list) => {
      setServers(list);
      // probe tools for all enabled servers on load
      list.filter((s) => s.enabled !== false).forEach((s) => probeTools(s));
    }).catch(console.error);
  }, []);

  const [importRaw, setImportRaw] = useState("");
  const [importError, setImportError] = useState("");
  const [importing, setImporting] = useState(false);

  // Parse standard MCP JSON config (Claude Desktop / Cursor format)
  const importFromJson = async () => {
    setImportError("");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(importRaw.trim());
      // Support both raw map and wrapped { mcpServers: {...} }
      const map = (parsed.mcpServers ?? parsed) as Record<string, unknown>;
      const entries = Object.entries(map);
      if (entries.length === 0) { setImportError("未找到任何服务器"); return; }
      setImporting(true);
      const added: MCPServer[] = [];
      for (const [id, cfg] of entries) {
        const c = cfg as Record<string, unknown>;
        const name = (c.name as string) || id;
        const disabled = c.disabled as boolean | undefined;
        const enabled = disabled !== true;
        let server: MCPServer;
        if (c.url || c.type === "streamableHttp" || c.type === "sse") {
          const transport: "sse" | "streamableHttp" =
            c.type === "sse" ? "sse" : "streamableHttp";
          server = {
            id, name, transport,
            url: c.url as string,
            headers: (c.headers as Record<string, string>) ?? {},
            env: (c.env as Record<string, string>) ?? {},
            enabled,
          };
        } else {
          server = {
            id, name, transport: "stdio",
            command: c.command as string,
            args: (c.args as string[]) ?? [],
            env: (c.env as Record<string, string>) ?? {},
            enabled,
          };
        }
        await window.agentApi.mcpSave(server);
        added.push(server);
      }
      const updated = await window.agentApi.mcpList();
      setServers(updated);
      setImportRaw("");
      added.filter((s) => s.enabled !== false).forEach((s) => probeTools(s));
    } catch (e) {
      setImportError(e instanceof Error ? e.message : "JSON 解析失败");
    } finally {
      setImporting(false);
    }
  };

  const isLocalValid = () => form.id.trim() !== "" && form.command.trim() !== "";
  const isRemoteValid = () => form.id.trim() !== "" && form.url.trim() !== "";

  // Parse "key: value" lines into a headers object
  const parseHeaders = (raw: string): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const idx = line.indexOf(":");
      if (idx < 1) continue;
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim();
      if (k) result[k] = v;
    }
    return result;
  };

  const addServer = async () => {
    setTouched({ id: true, command: true, url: true });
    if (transport === "stdio" && !isLocalValid()) return;
    if ((transport === "sse" || transport === "streamableHttp") && !isRemoteValid()) return;
    setSaving(true);
    try {
      const headers = (transport === "sse" || transport === "streamableHttp") ? parseHeaders(form.headersRaw) : {};
      const server: MCPServer = transport === "stdio"
        ? { id: form.id, name: form.name || form.id, transport: "stdio", command: form.command, args: form.args.split(" ").filter(Boolean), enabled: true }
        : { id: form.id, name: form.name || form.id, transport, url: form.url, headers, enabled: true };
      await window.agentApi.mcpSave(server);
      const updated = await window.agentApi.mcpList();
      setServers(updated);
      setForm(EMPTY_FORM);
      setTouched({ id: false, command: false, url: false });
      // probe the newly added server
      probeTools(server);
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

  const confirmAuth = async () => {
    if (!authDialog || !authToken.trim()) return;
    setAuthSaving(true);
    try {
      // For streamableHttp, token goes into headers; for sse/stdio, into env
      const updated: MCPServer = authDialog.server.transport === "streamableHttp"
        ? { ...authDialog.server, headers: { ...(authDialog.server.headers ?? {}), Authorization: `Bearer ${authToken.trim()}` } }
        : { ...authDialog.server, env: { ...(authDialog.server.env ?? {}), Authorization: `Bearer ${authToken.trim()}` } };
      await window.agentApi.mcpSave(updated);
      const list = await window.agentApi.mcpList();
      setServers(list);
      setAuthDialog(null);
      setAuthToken("");
      // re-probe with new token
      const saved = list.find((s) => s.id === updated.id) ?? updated;
      probeTools(saved);
    } finally {
      setAuthSaving(false);
    }
  };

  const transportLabel = (t: MCPServer["transport"]) =>
    t === "stdio" ? "本地" : t === "streamableHttp" ? "HTTP" : "SSE";
  const transportColor = (t: MCPServer["transport"]) =>
    t === "stdio" ? "#68d391" : t === "streamableHttp" ? "#f6ad55" : "#63b3ed";
  const transportBg = (t: MCPServer["transport"]) =>
    t === "stdio" ? "rgba(154,230,180,0.15)" : t === "streamableHttp" ? "rgba(246,173,85,0.15)" : "rgba(99,179,237,0.15)";

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
            {(["stdio", "sse", "streamableHttp"] as Transport[]).map((t) => (
              <button key={t} onClick={() => { setTransport(t); setTouched({ id: false, command: false, url: false }); setForm(f => ({ ...EMPTY_FORM, id: f.id, name: f.name })); }} style={{
                padding: "5px 14px", border: "none", fontSize: 12, fontWeight: 500, cursor: "pointer",
                fontFamily: "var(--font-body)", transition: "background 0.15s",
                background: transport === t ? "var(--accent)" : "transparent",
                color: transport === t ? "var(--text-inverse)" : "var(--text-muted)",
              }}>
                {t === "stdio" ? "本地 stdio" : t === "sse" ? "远程 SSE" : "HTTP"}
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Common: ID + Name */}
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
              <input value={form.id} onChange={(e) => setForm(f => ({ ...f, id: e.target.value }))} onBlur={() => setTouched(t => ({ ...t, id: true }))} placeholder="服务器 ID *" style={{ ...inputStyle, ...(touched.id && !form.id ? errorInputStyle : {}) }} />
              {touched.id && !form.id && <span style={{ fontSize: 11, color: "var(--danger)" }}>必填</span>}
            </div>
            <input value={form.name} onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} placeholder="显示名称" style={{ ...inputStyle, flex: 1 }} />
          </div>

          {transport === "stdio" ? (
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
                <input value={form.command} onChange={(e) => setForm(f => ({ ...f, command: e.target.value }))} onBlur={() => setTouched(t => ({ ...t, command: true }))} placeholder="命令（如 npx）*" style={{ ...inputStyle, ...(touched.command && !form.command ? errorInputStyle : {}) }} />
                {touched.command && !form.command && <span style={{ fontSize: 11, color: "var(--danger)" }}>必填</span>}
              </div>
              <input value={form.args} onChange={(e) => setForm(f => ({ ...f, args: e.target.value }))} placeholder="参数（如 -y @anthropic/mcp-server）" style={{ ...inputStyle, flex: 2 }} />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <input value={form.url} onChange={(e) => setForm(f => ({ ...f, url: e.target.value }))} onBlur={() => setTouched(t => ({ ...t, url: true }))} placeholder={transport === "streamableHttp" ? "HTTP URL（如 http://host/mcp）*" : "SSE URL（如 https://mcp.example.com/sse）*"} style={{ ...inputStyle, ...(touched.url && !form.url ? errorInputStyle : {}) }} />
                {touched.url && !form.url && <span style={{ fontSize: 11, color: "var(--danger)" }}>必填</span>}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={{ fontSize: 12, color: "var(--text-muted)" }}>请求头（每行 key: value）</label>
                <textarea
                  value={form.headersRaw}
                  onChange={(e) => setForm(f => ({ ...f, headersRaw: e.target.value }))}
                  placeholder={"access_token: abc123\nAuthorization: Bearer sk-..."}
                  rows={3}
                  style={{ ...inputStyle, fontFamily: "var(--font-mono)", fontSize: 12, resize: "vertical" }}
                />
              </div>
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

      {/* JSON import panel */}
      <div style={{ marginBottom: 28, padding: 20, background: "var(--bg-glass)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-subtle)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)" }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 8px" }}>导入 JSON 配置</h3>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 10px" }}>兼容 Claude Desktop / Cursor 格式，粘贴后点导入。</p>
        <textarea
          value={importRaw}
          onChange={(e) => { setImportRaw(e.target.value); setImportError(""); }}
          placeholder={'{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "some-mcp"]\n  }\n}'}
          rows={5}
          style={{ ...inputStyle, width: "100%", boxSizing: "border-box", fontFamily: "var(--font-mono)", fontSize: 12, resize: "vertical", marginBottom: 8 }}
        />
        {importError && <div style={{ fontSize: 12, color: "var(--danger)", marginBottom: 8 }}>{importError}</div>}
        <button onClick={importFromJson} disabled={!importRaw.trim() || importing} style={{ padding: "8px 20px", borderRadius: "var(--radius-sm)", border: "none", background: "var(--accent)", color: "var(--text-inverse)", fontSize: 13, fontWeight: 600, cursor: importRaw.trim() && !importing ? "pointer" : "not-allowed", fontFamily: "var(--font-body)", opacity: importRaw.trim() && !importing ? 1 : 0.5 }}>
          {importing ? "导入中…" : "导入"}
        </button>
      </div>

      {/* Server cards */}
      {servers.filter((s) => s.transport === transport).length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 14, padding: "40px 0", textAlign: "center" }}>
          暂无{transport === "stdio" ? "本地 stdio" : transport === "sse" ? "远程 SSE" : "HTTP"} 服务器，点击上方添加。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {servers.filter((s) => s.transport === transport).map((s) => (
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
                  <span style={{ fontSize: 10, padding: "1px 6px", borderRadius: 4, background: transportBg(s.transport), color: transportColor(s.transport), fontWeight: 600 }}>
                    {transportLabel(s.transport)}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, fontFamily: "var(--font-mono)" }}>
                  {s.transport === "stdio" ? `${s.command} ${(s.args ?? []).join(" ")}` : s.url}
                  {s.transport !== "stdio" && s.headers && Object.keys(s.headers).length > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-body)" }}>
                      · {Object.keys(s.headers).length} 个请求头
                    </span>
                  )}
                </div>
                {/* Tool tags / probe status */}
                {probingIds.has(s.id) ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", border: "2px solid var(--accent)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
                    探测工具中…
                  </div>
                ) : probeErrors[s.id] ? (
                  <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 11, color: "var(--danger)" }}>{probeErrors[s.id]}</span>
                    {(s.transport === "sse" || /401|403|unauthorized|forbidden|需要认证|访问被拒绝/i.test(probeErrors[s.id])) ? (
                      <button onClick={() => { setAuthToken(""); setAuthDialog({ server: s }); }} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(251,191,36,0.4)", background: "rgba(251,191,36,0.1)", color: "#fbbf24", cursor: "pointer", fontFamily: "var(--font-body)" }}>
                        输入 Token
                      </button>
                    ) : null}
                    <button onClick={() => probeTools(s)} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: "1px solid var(--border-default)", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontFamily: "var(--font-body)" }}>
                      重试
                    </button>
                  </div>
                ) : toolsMap[s.id] && toolsMap[s.id].length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6 }}>
                    {toolsMap[s.id].map((t) => (
                      <span key={t.name} title={t.description} style={{ fontSize: 11, padding: "2px 8px", borderRadius: 10, background: "rgba(168,85,247,0.12)", color: "#c084fc", border: "1px solid rgba(168,85,247,0.2)", fontFamily: "var(--font-mono)", cursor: "default" }}>
                        {t.name}
                      </span>
                    ))}
                  </div>
                ) : toolsMap[s.id] !== undefined ? (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6 }}>无可用工具</div>
                ) : null}
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

      {/* Auth dialog */}
      {authDialog && (
        <div style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setAuthDialog(null); }}>
          <div style={{ width: 420, background: "var(--bg-surface)", borderRadius: "var(--radius-md)", border: "1px solid var(--border-default)", padding: 28, boxShadow: "0 24px 48px rgba(0,0,0,0.4)" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>需要认证</h3>
            <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--text-muted)" }}>
              服务器 <strong style={{ color: "var(--text-primary)" }}>{authDialog.server.name || authDialog.server.id}</strong> 返回了 401/403，请输入访问令牌（Bearer Token）。
            </p>
            <input
              autoFocus
              type="password"
              value={authToken}
              onChange={(e) => setAuthToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") confirmAuth(); if (e.key === "Escape") setAuthDialog(null); }}
              placeholder="sk-… 或 Bearer token"
              style={{ ...inputStyle, width: "100%", boxSizing: "border-box", marginBottom: 16 }}
            />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setAuthDialog(null)} style={{ padding: "8px 18px", borderRadius: "var(--radius-sm)", border: "1px solid var(--border-default)", background: "transparent", color: "var(--text-muted)", fontSize: 13, cursor: "pointer", fontFamily: "var(--font-body)" }}>
                取消
              </button>
              <button onClick={confirmAuth} disabled={!authToken.trim() || authSaving} style={{ padding: "8px 18px", borderRadius: "var(--radius-sm)", border: "none", background: "var(--accent)", color: "var(--text-inverse)", fontSize: 13, fontWeight: 600, cursor: authToken.trim() && !authSaving ? "pointer" : "not-allowed", fontFamily: "var(--font-body)", opacity: authToken.trim() && !authSaving ? 1 : 0.5 }}>
                {authSaving ? "保存中…" : "保存并重试"}
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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