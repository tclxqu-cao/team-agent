import { useState, useEffect } from "react";
import type { LSPServerConfig } from "../global";

const PRESETS: Array<{ label: string; language: string; fileTypes: string; command: string; args: string }> = [
  { label: "TypeScript / JavaScript", language: "typescript", fileTypes: ".ts,.tsx,.js,.jsx", command: "typescript-language-server", args: "--stdio" },
  { label: "Python (pylsp)", language: "python", fileTypes: ".py", command: "pylsp", args: "" },
  { label: "Python (pyright)", language: "python", fileTypes: ".py", command: "pyright-langserver", args: "--stdio" },
  { label: "Rust (rust-analyzer)", language: "rust", fileTypes: ".rs", command: "rust-analyzer", args: "" },
  { label: "Go (gopls)", language: "go", fileTypes: ".go", command: "gopls", args: "" },
  { label: "C/C++ (clangd)", language: "cpp", fileTypes: ".c,.cpp,.cc,.h,.hpp", command: "clangd", args: "" },
  { label: "Java (jdtls via brew)", language: "java", fileTypes: ".java", command: "jdtls", args: "--data /tmp/jdtls-workspace" },
];

const EMPTY_FORM = { id: "", name: "", language: "", fileTypes: "", command: "", args: "", envRaw: "" };

export default function LSPServerList() {
  const [servers, setServers] = useState<LSPServerConfig[]>([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = async () => {
    if (!window.agentApi?.lspList) return;
    try {
      const list = await window.agentApi.lspList();
      setServers(list);
    } catch (e) {
      console.error("[LSP] load error", e);
    }
  };

  useEffect(() => { void load(); }, []);

  const applyPreset = (preset: typeof PRESETS[number]) => {
    setForm((f) => ({ ...f, name: preset.label, language: preset.language, fileTypes: preset.fileTypes, command: preset.command, args: preset.args }));
  };

  const startEdit = (server: LSPServerConfig) => {
    setEditingId(server.id);
    setForm({
      id: server.id,
      name: server.name,
      language: server.language,
      fileTypes: server.fileTypes.join(","),
      command: server.command,
      args: server.args.join(" "),
      envRaw: server.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join("\n") : "",
    });
    setExpandedId(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const save = async () => {
    if (!window.agentApi?.lspSave) return;
    const name = form.name.trim();
    const command = form.command.trim();
    if (!name || !command) return;

    let env: Record<string, string> | undefined;
    if (form.envRaw.trim()) {
      env = {};
      for (const line of form.envRaw.split("\n")) {
        const idx = line.indexOf("=");
        if (idx > 0) {
          env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
      }
    }

    const config: Omit<LSPServerConfig, "id"> & { id?: string } = {
      id: editingId ?? crypto.randomUUID(),
      name,
      language: form.language.trim(),
      fileTypes: form.fileTypes.split(",").map((s) => s.trim()).filter(Boolean),
      command,
      args: form.args.trim() ? form.args.trim().split(/\s+/) : [],
      env,
      enabled: true,
    };

    setSaving(true);
    try {
      await window.agentApi.lspSave(config);
      await load();
      cancelEdit();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    if (!window.agentApi?.lspDelete) return;
    if (!confirm("删除此 LSP 服务器配置?")) return;
    await window.agentApi.lspDelete(id);
    await load();
  };

  const toggleEnabled = async (server: LSPServerConfig) => {
    if (!window.agentApi?.lspSetEnabled) return;
    await window.agentApi.lspSetEnabled(server.id, !server.enabled);
    await load();
  };

  const isEditing = editingId !== null;
  const isNew = isEditing && editingId === null || (!editingId && form.name !== "");

  return (
    <div style={{ padding: "40px 48px", maxWidth: 720, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>LSP 服务器</h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
            配置 Language Server Protocol 服务器，让 Agent 可通过{" "}
            <code style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 4 }}>lsp_diagnostics</code>、
            <code style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 4 }}>lsp_hover</code>、
            <code style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 12, color: "var(--text-secondary)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 4 }}>lsp_definition</code>{" "}
            等工具进行代码分析。
          </p>
        </div>
        {!isEditing && (
          <button
            onClick={() => { setEditingId(""); setForm(EMPTY_FORM); }}
            style={{
              padding: "8px 16px",
              borderRadius: "var(--radius-sm)",
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              flexShrink: 0,
            }}
          >+ 添加服务器</button>
        )}
      </div>

      {/* Server list */}
      {servers.length === 0 && !isEditing && (
        <div style={{ color: "var(--text-muted)", fontSize: 14, padding: "40px 0", textAlign: "center" }}>
          尚未配置任何 LSP 服务器
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: isEditing ? 24 : 0 }}>
        {servers.map((server) => (
          <div
            key={server.id}
            style={{
              background: "var(--bg-glass)",
              border: "1px solid var(--border-subtle)",
              borderRadius: "var(--radius-md)",
              overflow: "hidden",
            }}
          >
            <div
              style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", cursor: "pointer" }}
              onClick={() => setExpandedId(expandedId === server.id ? null : server.id)}
            >
              {/* Enable toggle */}
              <div
                onClick={(e) => { e.stopPropagation(); void toggleEnabled(server); }}
                style={{
                  width: 32, height: 18, borderRadius: 9,
                  background: server.enabled ? "var(--success, #34d399)" : "var(--border-default)",
                  position: "relative", cursor: "pointer", flexShrink: 0, transition: "background 0.2s",
                }}
              >
                <div style={{
                  position: "absolute", top: 2, left: server.enabled ? 16 : 2,
                  width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s",
                }} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 13, color: "var(--text-primary)" }}>{server.name}</div>
                <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                  {server.language}{server.fileTypes.length > 0 ? ` · ${server.fileTypes.join(", ")}` : ""}
                </div>
              </div>

              <div style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono, monospace)", flexShrink: 0 }}>
                {server.command}{server.args.length ? " " + server.args.join(" ") : ""}
              </div>

              <button
                onClick={(e) => { e.stopPropagation(); startEdit(server); }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--text-muted)", fontSize: 13, padding: "2px 8px",
                  fontFamily: "var(--font-body)",
                }}
              >编辑</button>

              <button
                onClick={(e) => { e.stopPropagation(); void remove(server.id); }}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  color: "var(--danger, #f43f5e)", fontSize: 13, padding: "2px 8px",
                  fontFamily: "var(--font-body)",
                }}
              >删除</button>

              <svg
                width="12" height="12" viewBox="0 0 24 24" fill="none"
                stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round"
                style={{ flexShrink: 0, transition: "transform 0.2s", transform: expandedId === server.id ? "rotate(180deg)" : "none" }}
              >
                <path d="M6 9l6 6 6-6"/>
              </svg>
            </div>

            {expandedId === server.id && (
              <div style={{
                padding: "12px 16px",
                fontSize: 12,
                color: "var(--text-muted)",
                borderTop: "1px solid var(--border-subtle)",
                display: "flex", flexDirection: "column", gap: 6,
              }}>
                <div>
                  <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>命令：</span>
                  <code style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 4 }}>
                    {server.command} {server.args.join(" ")}
                  </code>
                </div>
                {server.fileTypes.length > 0 && (
                  <div>
                    <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>文件类型：</span>
                    {server.fileTypes.join(", ")}
                  </div>
                )}
                {server.env && Object.keys(server.env).length > 0 && (
                  <div>
                    <span style={{ color: "var(--text-secondary)", fontWeight: 500 }}>环境变量：</span>
                    {Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join(", ")}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Add / Edit form */}
      {isEditing && (
        <div style={{
          padding: "20px 24px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-glow)",
          background: "var(--bg-glass)",
        }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {editingId ? "编辑 LSP 服务器" : "添加 LSP 服务器"}
          </h3>

          {/* Presets */}
          <div style={{ marginBottom: 16 }}>
            <label style={labelStyle}>快速预设</label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  onClick={() => applyPreset(p)}
                  style={{
                    background: "var(--bg-deep)",
                    border: "1px solid var(--border-default)",
                    borderRadius: "var(--radius-sm)",
                    padding: "4px 10px",
                    fontSize: 11,
                    cursor: "pointer",
                    color: "var(--text-secondary)",
                    fontFamily: "var(--font-body)",
                  }}
                >{p.label}</button>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>名称 <span style={{ color: "var(--danger, #f43f5e)", textTransform: "none" }}>*</span></label>
                <input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="TypeScript Language Server"
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>语言</label>
                <input
                  value={form.language}
                  onChange={(e) => setForm((f) => ({ ...f, language: e.target.value }))}
                  placeholder="typescript"
                  style={inputStyle}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>
                文件类型
                <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, marginLeft: 6, color: "var(--text-muted)" }}>逗号分隔，如 .ts,.tsx</span>
              </label>
              <input
                value={form.fileTypes}
                onChange={(e) => setForm((f) => ({ ...f, fileTypes: e.target.value }))}
                placeholder=".ts,.tsx,.js,.jsx"
                style={inputStyle}
              />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div>
                <label style={labelStyle}>命令 <span style={{ color: "var(--danger, #f43f5e)", textTransform: "none" }}>*</span></label>
                <input
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  placeholder="typescript-language-server"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)" }}
                />
              </div>
              <div>
                <label style={labelStyle}>
                  参数
                  <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, marginLeft: 6, color: "var(--text-muted)" }}>空格分隔</span>
                </label>
                <input
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  placeholder="--stdio"
                  style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)" }}
                />
              </div>
            </div>

            <div>
              <label style={labelStyle}>
                环境变量
                <span style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, marginLeft: 6, color: "var(--text-muted)" }}>每行 KEY=VALUE</span>
              </label>
              <textarea
                value={form.envRaw}
                onChange={(e) => setForm((f) => ({ ...f, envRaw: e.target.value }))}
                placeholder={"NODE_ENV=production\nTSPROTOCOL_LOG=verbose"}
                rows={3}
                style={{ ...inputStyle, fontFamily: "var(--font-mono, monospace)", resize: "vertical" }}
              />
            </div>

            {form.language === "java" && (
              <div style={{
                background: "rgba(234,179,8,0.08)",
                border: "1px solid rgba(234,179,8,0.3)",
                borderRadius: "var(--radius-sm)",
                padding: "10px 14px",
                fontSize: 12,
                color: "var(--text-secondary)",
                lineHeight: 1.65,
              }}>
                <strong style={{ color: "rgba(202,138,4,1)" }}>Java 提示：</strong>
                {" "}使用 <code style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 3 }}>jdtls</code> 预设需先通过{" "}
                <code style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 3 }}>brew install jdtls</code>{" "}
                安装包装脚本。若手动安装，请将命令改为{" "}
                <code style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 3 }}>java</code>，
                并在参数中填入完整的 JVM 参数和{" "}
                <code style={{ fontFamily: "var(--font-mono, monospace)", background: "var(--bg-deep)", padding: "1px 5px", borderRadius: 3 }}>-jar .../launcher.jar -data /path/to/workspace</code>。
              </div>
            )}
          </div>

          <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
            <button
              onClick={() => void save()}
              disabled={saving || !form.name.trim() || !form.command.trim()}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                background: "var(--accent)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                opacity: saving || !form.name.trim() || !form.command.trim() ? 0.45 : 1,
                fontFamily: "var(--font-body)",
              }}
            >{saving ? "保存中…" : "保存"}</button>
            <button
              onClick={cancelEdit}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-default)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                fontFamily: "var(--font-body)",
              }}
            >取消</button>
          </div>
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)",
  background: "var(--bg-glass)",
  color: "var(--text-primary)",
  fontSize: 13,
  fontFamily: "var(--font-body)",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 4,
  display: "block",
};
