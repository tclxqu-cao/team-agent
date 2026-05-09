import { useEffect, useState } from "react";

interface Skill {
  name: string;
  description: string;
  triggers: string[];
  prompt: string;
  filePath?: string;
  enabled?: boolean;
}

const emptySkill = (): Skill => ({
  name: "",
  description: "",
  triggers: [],
  prompt: "",
  filePath: "",
  enabled: true,
});

export default function SkillManager() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [editing, setEditing] = useState<Skill | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "error">("success");
  const [triggersInput, setTriggersInput] = useState("");

  const showNotice = (msg: string, type: "success" | "error" = "success") => {
    setNotice(msg);
    setNoticeType(type);
    setTimeout(() => setNotice(null), 3000);
  };

  const load = async () => {
    if (!window.agentApi) return;
    const list = await window.agentApi.listSkills();
    setSkills(list as Skill[]);
  };

  useEffect(() => { load(); }, []);

  const handleEdit = (skill: Skill) => {
    setEditing({ ...skill });
    setTriggersInput((skill.triggers ?? []).join(", "));
    setIsNew(false);
  };

  const handleNew = () => {
    setEditing(emptySkill());
    setTriggersInput("");
    setIsNew(true);
  };

  const handleCancel = () => {
    setEditing(null);
    setIsNew(false);
  };

  const handleSave = async () => {
    if (!editing || !window.agentApi) return;
    if (!editing.name.trim()) {
      showNotice("名称不能为空", "error");
      return;
    }
    const triggers = triggersInput
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    try {
      await window.agentApi.saveSkill({
        name: editing.name.trim(),
        description: editing.description,
        triggers,
        prompt: editing.prompt,
        filePath: editing.filePath ?? "",
      });
      showNotice(isNew ? "技能已创建" : "技能已保存");
      setEditing(null);
      await load();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "保存失败", "error");
    }
  };

  const handleDelete = async (name: string) => {
    if (!window.agentApi) return;
    try {
      await window.agentApi.deleteSkill(name);
      showNotice("已删除");
      if (editing?.name === name) setEditing(null);
      await load();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "删除失败", "error");
    }
  };

  const handleToggleEnabled = async (skill: Skill) => {
    if (!window.agentApi) return;
    const next = !skill.enabled;
    await window.agentApi.setSkillEnabled(skill.name, next);
    await load();
  };

  const handleImport = async () => {
    if (!window.agentApi) return;
    try {
      const result = await window.agentApi.importSkill();
      if (!result) return; // user cancelled
      showNotice(`已导入技能「${result.name}」，本次会话立即生效`);
      await load();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : "导入失败", "error");
    }
  };

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

  return (
    <div style={{ padding: "40px 48px", maxWidth: 720, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div>
          <h2 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: 0 }}>技能管理</h2>
          <p style={{ fontSize: 13, color: "var(--text-muted)", margin: "4px 0 0" }}>
            配置触发词和提示词，让 Agent 自动激活专属技能
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={handleImport}
            style={{
              padding: "8px 16px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-default)",
              background: "transparent",
              color: "var(--text-secondary)",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >↓ 导入技能</button>
          <button
            onClick={handleNew}
            style={{
              padding: "8px 16px",
              borderRadius: "var(--radius-sm)",
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >+ 新建技能</button>
        </div>
      </div>

      {notice && (
        <div style={{
          marginBottom: 16,
          padding: "8px 12px",
          borderRadius: "var(--radius-sm)",
          border: noticeType === "success" ? "1px solid rgba(52,211,153,0.35)" : "1px solid rgba(244,63,94,0.35)",
          background: noticeType === "success" ? "rgba(52,211,153,0.08)" : "rgba(244,63,94,0.08)",
          color: noticeType === "success" ? "var(--success)" : "var(--danger)",
          fontSize: 13,
        }}>
          {notice}
        </div>
      )}

      {/* Edit / New form */}
      {editing && (
        <div style={{
          marginBottom: 24,
          padding: "20px 24px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--border-glow)",
          background: "var(--bg-glass)",
        }}>
          <h3 style={{ margin: "0 0 16px", fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>
            {isNew ? "新建技能" : `编辑：${editing.name}`}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div>
              <label style={labelStyle}>名称</label>
              <input
                style={inputStyle}
                value={editing.name}
                disabled={!isNew}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="技能唯一标识，如 code-review"
              />
            </div>
            <div>
              <label style={labelStyle}>描述</label>
              <input
                style={inputStyle}
                value={editing.description}
                onChange={(e) => setEditing({ ...editing, description: e.target.value })}
                placeholder="简短说明这个技能的用途"
              />
            </div>
            <div>
              <label style={labelStyle}>触发词（逗号分隔）</label>
              <input
                style={inputStyle}
                value={triggersInput}
                onChange={(e) => setTriggersInput(e.target.value)}
                placeholder="代码审查, review, 审查代码"
              />
            </div>
            <div>
              <label style={labelStyle}>提示词</label>
              <textarea
                style={{ ...inputStyle, minHeight: 120, resize: "vertical" }}
                value={editing.prompt}
                onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
                placeholder="当触发词匹配时，注入到系统提示的内容..."
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <button
              onClick={handleSave}
              style={{
                padding: "8px 20px",
                borderRadius: "var(--radius-sm)",
                border: "none",
                background: "var(--accent)",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >保存</button>
            <button
              onClick={handleCancel}
              style={{
                padding: "8px 16px",
                borderRadius: "var(--radius-sm)",
                border: "1px solid var(--border-default)",
                background: "transparent",
                color: "var(--text-secondary)",
                fontSize: 13,
                cursor: "pointer",
              }}
            >取消</button>
          </div>
        </div>
      )}

      {/* Skill list */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {skills.length === 0 && !editing && (
          <div style={{ color: "var(--text-muted)", fontSize: 13, padding: "20px 0", textAlign: "center" }}>
            暂无技能，点击「新建技能」创建第一个
          </div>
        )}
        {skills.map((skill) => (
          <div
            key={skill.name}
            style={{
              display: "flex",
              alignItems: "flex-start",
              gap: 12,
              padding: "14px 16px",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--border-subtle)",
              background: "var(--bg-glass)",
              opacity: skill.enabled === false ? 0.5 : 1,
            }}
          >
            {/* Enable toggle */}
            <button
              onClick={() => handleToggleEnabled(skill)}
              title={skill.enabled === false ? "已禁用，点击启用" : "点击禁用"}
              style={{
                flexShrink: 0,
                marginTop: 2,
                width: 32,
                height: 18,
                borderRadius: 9,
                border: "none",
                background: skill.enabled === false ? "var(--border-default)" : "var(--accent)",
                cursor: "pointer",
                position: "relative",
                transition: "background 0.2s",
              }}
            >
              <span style={{
                position: "absolute",
                top: 2,
                left: skill.enabled === false ? 2 : 14,
                width: 14,
                height: 14,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 0.2s",
              }} />
            </button>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
                <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>{skill.name}</span>
                {skill.triggers?.length > 0 && (
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                    触发词：{skill.triggers.slice(0, 3).join(" · ")}{skill.triggers.length > 3 ? " ..." : ""}
                  </span>
                )}
              </div>
              {skill.description && (
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 4 }}>{skill.description}</div>
              )}
              {skill.prompt && (
                <div style={{
                  fontSize: 11,
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "100%",
                  opacity: 0.7,
                }}>
                  {skill.prompt.slice(0, 80)}{skill.prompt.length > 80 ? "..." : ""}
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button
                onClick={() => handleEdit(skill)}
                style={{
                  padding: "5px 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--border-default)",
                  background: "transparent",
                  color: "var(--text-secondary)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >编辑</button>
              <button
                onClick={() => handleDelete(skill.name)}
                style={{
                  padding: "5px 12px",
                  borderRadius: "var(--radius-sm)",
                  border: "1px solid rgba(244,63,94,0.3)",
                  background: "transparent",
                  color: "var(--danger)",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >删除</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
