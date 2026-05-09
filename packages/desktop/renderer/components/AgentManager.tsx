import { useState, useEffect } from "react";
import type { AgentDefinition, ContextPlaceholder, AgentCapabilities } from "../global.d.ts";
import { useSettingsStore } from "../stores/settingsStore";

const BUILTIN_TOOLS = [
  { name: "read_file",  label: "读取文件" },
  { name: "write_file", label: "写入文件" },
  { name: "bash",       label: "执行命令" },
  { name: "web_fetch",  label: "网页抓取" },
  { name: "web_search", label: "网络搜索" },
  { name: "grep",       label: "文件搜索" },
];

function emptyCapabilities(): AgentCapabilities {
  return { profileId: "", enabledTools: [], enabledSkills: [], enabledMCPServers: [] };
}

function emptyAgent(): Omit<AgentDefinition, "id" | "created" | "updated"> {
  return {
    name: "",
    description: "",
    systemPrompt: "",
    contextPlaceholders: [],
    capabilities: emptyCapabilities(),
    maxIterations: 0,
    isDefault: false,
  };
}

// ── Small shared button styles ──────────────────────────────────────────────
const btnSmall: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 7,
  border: "1px solid var(--border-default)",
  background: "var(--bg-deep)",
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};
const btnXs: React.CSSProperties = {
  padding: "3px 9px",
  borderRadius: 6,
  border: "1px solid var(--border-default)",
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: 11,
  cursor: "pointer",
};
const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: 7,
  border: "1px solid var(--border-default)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};
const labelStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 5,
  display: "block",
};

// ── Context placeholder editor ───────────────────────────────────────────────
function PlaceholderRow({
  ph, onChange, onDelete,
}: {
  ph: ContextPlaceholder;
  onChange: (updated: ContextPlaceholder) => void;
  onDelete: () => void;
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr 1fr auto", gap: 6, alignItems: "center" }}>
      <input
        style={inputStyle}
        placeholder="变量名 (e.g. project)"
        value={ph.key}
        onChange={(e) => onChange({ ...ph, key: e.target.value })}
      />
      <input
        style={inputStyle}
        placeholder="说明"
        value={ph.description}
        onChange={(e) => onChange({ ...ph, description: e.target.value })}
      />
      <input
        style={inputStyle}
        placeholder="默认值"
        value={ph.defaultValue}
        onChange={(e) => onChange({ ...ph, defaultValue: e.target.value })}
      />
      <button onClick={onDelete} style={{ ...btnXs, color: "var(--danger)", borderColor: "rgba(244,63,94,0.25)", flexShrink: 0 }}>✕</button>
    </div>
  );
}

// ── Full agent form ──────────────────────────────────────────────────────────
function AgentForm({
  initial,
  activeAgentId,
  onSave,
  onCancel,
}: {
  initial: Partial<AgentDefinition>;
  activeAgentId: string;
  onSave: (data: Omit<AgentDefinition, "id" | "created" | "updated">) => Promise<void>;
  onCancel: () => void;
}) {
  const { profiles } = useSettingsStore();
  const [skills, setSkills] = useState<Array<{ name: string; description: string }>>([]);
  const [mcpServers, setMcpServers] = useState<Array<{ id: string; name: string }>>([]);

  const [draft, setDraft] = useState<Omit<AgentDefinition, "id" | "created" | "updated">>({
    ...emptyAgent(),
    ...initial,
    capabilities: { ...emptyCapabilities(), ...(initial.capabilities ?? {}) },
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!window.agentApi) return;
    window.agentApi.listSkills().then((list) => {
      setSkills((list as Array<{ name: string; description: string }>).filter((s) => s.name));
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window.agentApi as any).listMCPServers?.().then((list: any[]) => {
      setMcpServers(list ?? []);
    }).catch(() => { /* mcp list optional */ });
  }, []);

  const setCap = (update: Partial<AgentCapabilities>) =>
    setDraft((d) => ({ ...d, capabilities: { ...d.capabilities, ...update } }));

  const toggleTool = (name: string) => {
    const current = draft.capabilities.enabledTools;
    if (current.length === 0) {
      // "all enabled" → now restricting to all-except-this
      const all = BUILTIN_TOOLS.map((t) => t.name).filter((n) => n !== name);
      setCap({ enabledTools: all });
    } else if (current.includes(name)) {
      const next = current.filter((n) => n !== name);
      setCap({ enabledTools: next });
    } else {
      const next = [...current, name];
      // If all tools selected → collapse back to empty (= all)
      if (next.length === BUILTIN_TOOLS.length) setCap({ enabledTools: [] });
      else setCap({ enabledTools: next });
    }
  };

  const toggleSkill = (name: string) => {
    const cur = draft.capabilities.enabledSkills;
    setCap({ enabledSkills: cur.includes(name) ? cur.filter((n) => n !== name) : [...cur, name] });
  };

  const toggleMCP = (id: string) => {
    const cur = draft.capabilities.enabledMCPServers;
    setCap({ enabledMCPServers: cur.includes(id) ? cur.filter((n) => n !== id) : [...cur, id] });
  };

  const addPlaceholder = () =>
    setDraft((d) => ({
      ...d,
      contextPlaceholders: [...d.contextPlaceholders, { key: "", description: "", defaultValue: "" }],
    }));

  const updatePh = (i: number, updated: ContextPlaceholder) =>
    setDraft((d) => {
      const arr = [...d.contextPlaceholders];
      arr[i] = updated;
      return { ...d, contextPlaceholders: arr };
    });

  const deletePh = (i: number) =>
    setDraft((d) => ({ ...d, contextPlaceholders: d.contextPlaceholders.filter((_, j) => j !== i) }));

  const handleSave = async () => {
    if (!draft.name.trim()) { setError("名称为必填项"); return; }
    setSaving(true);
    try {
      await onSave(draft);
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const isToolEnabled = (name: string) =>
    draft.capabilities.enabledTools.length === 0 || draft.capabilities.enabledTools.includes(name);

  const sectionHead: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    marginBottom: 10,
    marginTop: 22,
    paddingBottom: 5,
    borderBottom: "1px solid var(--border-subtle)",
  };

  return (
    <div style={{ padding: "24px 28px", background: "transparent", borderTop: "1px solid var(--border-subtle)" }}>
      {error && (
        <div style={{
          marginBottom: 12,
          padding: "8px 12px",
          borderRadius: 7,
          background: "rgba(244,63,94,0.08)",
          border: "1px solid rgba(244,63,94,0.25)",
          color: "var(--danger)",
          fontSize: 12,
        }}>{error}</div>
      )}

      {/* ── Basic info ── */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <label style={labelStyle}>名称 *</label>
          <input style={inputStyle} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} placeholder="智能体名称" />
        </div>
        <div>
          <label style={labelStyle}>描述</label>
          <input style={inputStyle} value={draft.description} onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))} placeholder="一句话描述" />
        </div>
      </div>

      {/* ── System prompt ── */}
      <div style={{ marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
          <label style={{ ...labelStyle, marginBottom: 0 }}>角色设定 / 工作指令</label>
          <span style={{ fontSize: 11, color: "var(--text-muted)", opacity: 0.6 }}>支持 {"{{变量名}}"} 占位符</span>
        </div>
        <textarea
          value={draft.systemPrompt}
          onChange={(e) => setDraft((d) => ({ ...d, systemPrompt: e.target.value }))}
          placeholder={"你是一名专业的代码审查助手，请用中文回复所有问题。\n\n当前项目：{{project_name}}"}
          rows={6}
          style={{
            ...inputStyle,
            resize: "vertical",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            lineHeight: 1.6,
          }}
        />
      </div>

      {/* ── Context placeholders ── */}
      <p style={sectionHead}>上下文占位符</p>
      {draft.contextPlaceholders.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1.5fr 1fr auto", gap: 6 }}>
            {["变量名", "说明", "默认值", ""].map((h) => (
              <span key={h} style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.05em" }}>{h}</span>
            ))}
          </div>
          {draft.contextPlaceholders.map((ph, i) => (
            <PlaceholderRow key={i} ph={ph} onChange={(u) => updatePh(i, u)} onDelete={() => deletePh(i)} />
          ))}
        </div>
      )}
      <button onClick={addPlaceholder} style={{ ...btnXs, color: "var(--accent)", borderColor: "rgba(79,110,247,0.25)" }}>
        + 添加占位符
      </button>

      {/* ── Capabilities ── */}
      <p style={sectionHead}>能力配置</p>

      {/* Model */}
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>模型</label>
        <select
          value={draft.capabilities.profileId}
          onChange={(e) => setCap({ profileId: e.target.value })}
          style={{ ...inputStyle, cursor: "pointer" }}
        >
          <option value="">使用全局活跃模型</option>
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name || p.modelId} ({p.provider})</option>
          ))}
        </select>
      </div>

      {/* Tools */}
      <div style={{ marginBottom: 14 }}>
        <label style={labelStyle}>内置工具 {draft.capabilities.enabledTools.length === 0 ? "（全部启用）" : `（${draft.capabilities.enabledTools.length}/${BUILTIN_TOOLS.length}）`}</label>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {BUILTIN_TOOLS.map((t) => {
            const on = isToolEnabled(t.name);
            return (
              <button
                key={t.name}
                onClick={() => toggleTool(t.name)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 20,
                  border: on ? "1px solid var(--accent)" : "1px solid var(--border-subtle)",
                  background: on ? "var(--accent-dim)" : "transparent",
                  color: on ? "var(--accent)" : "var(--text-muted)",
                  fontSize: 12,
                  cursor: "pointer",
                  transition: "all 0.12s",
                }}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 5, opacity: 0.7 }}>
          点击切换；全选时恢复为"全部启用"
        </p>
      </div>

      {/* Skills */}
      {skills.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>技能 {draft.capabilities.enabledSkills.length === 0 ? "（全部）" : `（${draft.capabilities.enabledSkills.length}/${skills.length}）`}</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {skills.map((s) => {
              const on = draft.capabilities.enabledSkills.length === 0 || draft.capabilities.enabledSkills.includes(s.name);
              return (
                <button
                  key={s.name}
                  onClick={() => toggleSkill(s.name)}
                  title={s.description}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 20,
                    border: on ? "1px solid var(--accent)" : "1px solid var(--border-subtle)",
                    background: on ? "var(--accent-dim)" : "transparent",
                    color: on ? "var(--accent)" : "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    transition: "all 0.12s",
                  }}
                >
                  {s.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* MCP Servers */}
      {mcpServers.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>MCP 服务器 {draft.capabilities.enabledMCPServers.length === 0 ? "（全部）" : `（${draft.capabilities.enabledMCPServers.length}/${mcpServers.length}）`}</label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {mcpServers.map((m) => {
              const on = draft.capabilities.enabledMCPServers.length === 0 || draft.capabilities.enabledMCPServers.includes(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => toggleMCP(m.id)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 20,
                    border: on ? "1px solid var(--accent)" : "1px solid var(--border-subtle)",
                    background: on ? "var(--accent-dim)" : "transparent",
                    color: on ? "var(--accent)" : "var(--text-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    transition: "all 0.12s",
                  }}
                >
                  {m.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Advanced */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div>
          <label style={labelStyle}>最大迭代次数（0 = 全局）</label>
          <input
            type="number"
            style={inputStyle}
            value={draft.maxIterations}
            min={0}
            max={100}
            onChange={(e) => setDraft((d) => ({ ...d, maxIterations: Number(e.target.value) }))}
          />
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 2 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--text-secondary)" }}>
            <input
              type="checkbox"
              checked={draft.isDefault}
              onChange={(e) => setDraft((d) => ({ ...d, isDefault: e.target.checked }))}
              style={{ width: 14, height: 14, accentColor: "var(--accent)", cursor: "pointer" }}
            />
            新会话默认使用此智能体
          </label>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            ...btnSmall,
            background: "var(--accent)",
            color: "#fff",
            border: "none",
            fontWeight: 600,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={onCancel} style={btnSmall}>取消</button>
      </div>
    </div>
  );
}

// ── Main AgentManager component ──────────────────────────────────────────────
export default function AgentManager() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [activeAgentIds, setActiveAgentIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "error">("success");

  const showNotice = (msg: string, type: "success" | "error" = "success") => {
    setNotice(msg);
    setNoticeType(type);
    setTimeout(() => setNotice(null), 2000);
  };

  const load = async () => {
    if (!window.agentApi) return;
    const list = await window.agentApi.listAgentDefs();
    setAgents(list);
    const s = await window.agentApi.getSettings();
    setActiveAgentIds((s as Record<string, unknown>).activeAgentIds as string[] ?? []);
  };

  useEffect(() => { void load(); }, []);

  const handleCreate = async (data: Omit<AgentDefinition, "id" | "created" | "updated">) => {
    await window.agentApi.createAgentDef(data as Record<string, unknown>);
    setIsNew(false);
    showNotice("智能体已创建");
    await load();
  };

  const handleUpdate = async (id: string, data: Omit<AgentDefinition, "id" | "created" | "updated">) => {
    await window.agentApi.updateAgentDef(id, data as Record<string, unknown>);
    setEditingId(null);
    showNotice("保存成功");
    await load();
  };

  const handleDelete = async (id: string) => {
    await window.agentApi.deleteAgentDef(id);
    if (editingId === id) setEditingId(null);
    showNotice("已删除");
    await load();
  };

  const handleSetActive = async (id: string) => {
    const result = await window.agentApi.setActiveAgentDef(id);
    const newIds = (result as Record<string, unknown>).activeAgentIds as string[] ?? [];
    setActiveAgentIds(newIds);
    showNotice(newIds.includes(id) ? "已激活" : "已取消激活");
  };

  return (
    <div style={{ padding: "40px 48px", maxWidth: 720, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      <h2 style={{
        fontFamily: "var(--font-display)",
        fontSize: 28,
        color: "var(--text-primary)",
        fontWeight: 400,
        marginBottom: 8,
        letterSpacing: "-0.02em",
      }}>
        智能体
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 28 }}>
        配置具有自定义角色、工具和模型的智能体，在消息框中按需切换。
      </p>

      {notice && (
        <div style={{
          marginBottom: 16,
          padding: "8px 14px",
          borderRadius: 8,
          border: noticeType === "success" ? "1px solid rgba(52,211,153,0.35)" : "1px solid rgba(244,63,94,0.35)",
          background: noticeType === "success" ? "rgba(52,211,153,0.08)" : "rgba(244,63,94,0.08)",
          color: noticeType === "success" ? "var(--success)" : "var(--danger)",
          fontSize: 13,
        }}>{notice}</div>
      )}

      {/* New button */}
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <button
          onClick={() => { setIsNew(true); setEditingId(null); }}
          style={{ ...btnSmall, background: "var(--accent)", color: "#fff", border: "none", fontWeight: 600 }}
        >
          + 新建智能体
        </button>
      </div>

      {/* New form */}
      {isNew && (
        <div style={{
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border-default)",
          overflow: "hidden",
          marginBottom: 16,
        }}>
          <div style={{ padding: "10px 16px", background: "var(--bg-surface)", display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)" }}>新建智能体</span>
          </div>
          <AgentForm
            initial={{}}
            activeAgentId={activeAgentIds[0] ?? ""}
            onSave={handleCreate}
            onCancel={() => setIsNew(false)}
          />
        </div>
      )}

      {/* Agent list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {agents.length === 0 && !isNew && (
          <div style={{
            padding: "28px 20px",
            borderRadius: "var(--radius-sm)",
            border: "1px dashed var(--border-subtle)",
            textAlign: "center",
            color: "var(--text-muted)",
            fontSize: 13,
          }}>
            暂无智能体配置，点击「新建智能体」开始创建
          </div>
        )}

        {agents.map((agent) => {
          const isActive = activeAgentIds.includes(agent.id);
          const isEditing = agent.id === editingId;
          return (
            <div
              key={agent.id}
              style={{
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${isActive ? "var(--accent)" : "var(--border-default)"}`,
                background: isActive ? "var(--accent-dim)" : "var(--bg-surface)",
                overflow: "hidden",
                transition: "border-color 0.2s, background 0.2s",
              }}
            >
              {/* Card header */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px" }}>
                {/* Icon */}
                <div style={{
                  width: 34,
                  height: 34,
                  borderRadius: 8,
                  flexShrink: 0,
                  background: isActive ? "var(--accent)" : "var(--bg-deep)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke={isActive ? "#fff" : "var(--text-muted)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="8" r="4"/><path d="M20 21a8 8 0 1 0-16 0"/>
                  </svg>
                </div>

                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{agent.name}</span>
                    {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: "var(--accent)", background: "rgba(79,110,247,0.12)", padding: "1px 6px", borderRadius: 4, letterSpacing: "0.05em" }}>激活</span>}
                    {agent.isDefault && <span style={{ fontSize: 10, color: "var(--text-muted)", background: "var(--bg-deep)", padding: "1px 6px", borderRadius: 4 }}>默认</span>}
                  </div>
                  {agent.description && (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {agent.description}
                    </div>
                  )}
                  {/* Capability badges */}
                  <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                    {agent.capabilities.profileId && (
                      <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: "rgba(79,110,247,0.08)", color: "var(--accent)", border: "1px solid rgba(79,110,247,0.15)" }}>
                        自定义模型
                      </span>
                    )}
                    {agent.capabilities.enabledTools.length > 0 && (
                      <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: "var(--bg-deep)", color: "var(--text-muted)", border: "1px solid var(--border-subtle)" }}>
                        {agent.capabilities.enabledTools.length} 工具
                      </span>
                    )}
                    {agent.capabilities.enabledSkills.length > 0 && (
                      <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: "var(--bg-deep)", color: "var(--text-muted)", border: "1px solid var(--border-subtle)" }}>
                        {agent.capabilities.enabledSkills.length} 技能
                      </span>
                    )}
                    {agent.contextPlaceholders.length > 0 && (
                      <span style={{ fontSize: 10, padding: "1px 7px", borderRadius: 10, background: "var(--bg-deep)", color: "var(--text-muted)", border: "1px solid var(--border-subtle)" }}>
                        {agent.contextPlaceholders.length} 变量
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => handleSetActive(agent.id)}
                    style={{
                      ...btnXs,
                      color: isActive ? "var(--accent)" : "var(--text-muted)",
                      borderColor: isActive ? "var(--accent)" : "var(--border-default)",
                      background: isActive ? "var(--accent-dim)" : "transparent",
                    }}
                  >
                    {isActive ? "取消激活" : "激活"}
                  </button>
                  <button onClick={() => setEditingId(isEditing ? null : agent.id)} style={btnXs}>
                    {isEditing ? "收起" : "编辑"}
                  </button>
                  <button
                    onClick={() => handleDelete(agent.id)}
                    style={{ ...btnXs, color: "var(--danger)", borderColor: "rgba(244,63,94,0.25)" }}
                  >
                    删除
                  </button>
                </div>
              </div>

              {/* Inline editor */}
              {isEditing && (
                <AgentForm
                  initial={agent}
                  activeAgentId={activeAgentIds[0] ?? ""}
                  onSave={(data) => handleUpdate(agent.id, data)}
                  onCancel={() => setEditingId(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
