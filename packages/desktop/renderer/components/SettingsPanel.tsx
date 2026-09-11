import { useEffect, useState } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { ModelProfile } from "../global.d.ts";
import DesktopLiveSettings from "./DesktopLiveSettings";

const PROVIDERS = [
  { value: "anthropic", label: "Anthropic" },
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
];

const PROVIDER_DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4o",
  deepseek: "deepseek-chat",
};

function emptyProfile(): Omit<ModelProfile, "id"> {
  return { name: "", provider: "anthropic", modelId: "claude-sonnet-4-6", apiKey: "", baseUrl: "" };
}

export default function SettingsPanel() {
  const {
    maxIterations, contextWindow, isConfigured,
    profiles, activeProfileId,
    setField, loadFromSystem, saveToSystem,
    addProfile, updateProfile, deleteProfile, switchActiveProfile,
  } = useSettingsStore();

  const [notice, setNotice] = useState<string | null>(null);
  const [noticeType, setNoticeType] = useState<"success" | "error">("success");
  const [contextTokensDraft, setContextTokensDraft] = useState(String(Math.round((contextWindow ?? 100) * 1000)));
  useEffect(() => { setContextTokensDraft(String(Math.round((contextWindow ?? 100) * 1000))); }, [contextWindow]);

  // Profile editor state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [draft, setDraft] = useState<Omit<ModelProfile, "id">>(emptyProfile());

  useEffect(() => { loadFromSystem(); }, []);

  const startNew = () => {
    setIsNew(true);
    setEditingId(null);
    setDraft(emptyProfile());
  };

  const startEdit = (p: ModelProfile) => {
    setIsNew(false);
    setEditingId(p.id);
    setDraft({
      name: p.name,
      provider: p.provider,
      modelId: p.modelId,
      apiKey: ["managed", "__agentroam_stored_secret__"].includes(p.apiKey) ? "" : p.apiKey,
      baseUrl: p.baseUrl,
    });
  };

  const cancelEdit = () => { setEditingId(null); setIsNew(false); };

  const saveDraft = async () => {
    if (!draft.name.trim() || !draft.apiKey.trim() || !draft.modelId.trim()) {
      setNotice("名称、API Key 和模型 ID 为必填项");
      setNoticeType("error");
      return;
    }
    if (isNew) {
      addProfile(draft);
    } else if (editingId) {
      updateProfile(editingId, draft);
    }
    setEditingId(null);
    setIsNew(false);
    setNotice(null);
    // Auto-save profiles
    setTimeout(() => saveToSystem(), 0);
  };

  const handleDelete = async (id: string) => {
    deleteProfile(id);
    setTimeout(() => saveToSystem(), 0);
  };

  const handleSwitch = async (id: string) => {
    await switchActiveProfile(id);
    setNotice("已切换模型");
    setNoticeType("success");
    setTimeout(() => setNotice(null), 1500);
  };

  const handleSaveGeneral = async () => {
    setNotice(null);
    const tokens = Number(contextTokensDraft);
    if (!Number.isInteger(tokens) || tokens < 1024 || tokens > 2_000_000) {
      setNotice("上下文窗口请输入 1024 到 2000000 之间的整数 tokens，例如 8192。");
      setNoticeType("error");
      return;
    }
    // Persist K tokens for compatibility with existing settings and consumers.
    setField("contextWindow", tokens / 1000);
    try {
      await saveToSystem();
      setNotice("设置保存成功");
      setNoticeType("success");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "保存失败");
      setNoticeType("error");
    }
  };

  const showForm = isNew || editingId !== null;

  return (
    <div style={{ padding: "40px 48px", maxWidth: 640, animation: "fadeInUp 0.4s var(--ease-out)" }}>
      <h2 style={{
        fontFamily: "var(--font-display)",
        fontSize: 28,
        color: "var(--text-primary)",
        fontWeight: 400,
        marginBottom: 8,
        letterSpacing: "-0.02em",
      }}>
        设置
      </h2>
      <p style={{ color: "var(--text-muted)", fontSize: 14, marginBottom: 36 }}>
        管理模型提供商和运行参数。工作目录在项目设置中配置。
      </p>

      {/* ── Model Profiles ── */}
      <section style={{ marginBottom: 40 }}>
        <div className="settings-head-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", margin: 0 }}>
            模型提供商
          </h3>
          <button onClick={startNew} style={btnSmallStyle}>
            + 添加
          </button>
        </div>

        {/* Profile list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {profiles.length === 0 && !showForm && (
            <div style={{
              padding: "20px 16px",
              borderRadius: "var(--radius-sm)",
              border: "1px dashed var(--border-subtle)",
              textAlign: "center",
              color: "var(--text-muted)",
              fontSize: 13,
            }}>
              暂无配置，点击「+ 添加」创建第一个模型提供商
            </div>
          )}

          {profiles.map((p) => {
            const isActive = p.id === activeProfileId;
            const isEditing = p.id === editingId;
            return (
              <div key={p.id} style={{
                borderRadius: "var(--radius-sm)",
                border: `1px solid ${isActive ? "var(--accent)" : "var(--border-default)"}`,
                background: isActive ? "var(--accent-dim)" : "var(--bg-surface)",
                overflow: "hidden",
                transition: "border-color 0.2s",
              }}>
                {/* Row */}
                <div className="profile-row" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px" }}>
                  {/* Provider badge */}
                  <span style={{
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    padding: "2px 7px",
                    borderRadius: 4,
                    background: isActive ? "var(--accent)" : "var(--bg-deep)",
                    color: isActive ? "#fff" : "var(--text-muted)",
                    flexShrink: 0,
                  }}>
                    {p.provider}
                  </span>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.name || p.modelId}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>
                      {p.modelId} {p.baseUrl ? `· ${p.baseUrl}` : ""}
                    </div>
                  </div>

                  {isActive && (
                    <span style={{ fontSize: 11, color: "var(--accent)", fontWeight: 600, flexShrink: 0 }}>● 使用中</span>
                  )}

                  <div className="profile-row-actions" style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {!isActive && (
                      <button onClick={() => handleSwitch(p.id)} style={btnXsStyle}>切换</button>
                    )}
                    <button onClick={() => isEditing ? cancelEdit() : startEdit(p)} style={btnXsStyle}>
                      {isEditing ? "收起" : "编辑"}
                    </button>
                    <button
                      onClick={() => handleDelete(p.id)}
                      style={{ ...btnXsStyle, color: "var(--danger)", borderColor: "rgba(244,63,94,0.25)" }}
                    >
                      删除
                    </button>
                  </div>
                </div>

                {/* Inline edit form */}
                {isEditing && (
                  <ProfileForm draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={cancelEdit} />
                )}
              </div>
            );
          })}

          {/* New profile form */}
          {isNew && (
            <div style={{
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--accent)",
              background: "var(--bg-surface)",
            }}>
              <div style={{ padding: "10px 14px 0", fontSize: 13, fontWeight: 600, color: "var(--accent)" }}>
                新建提供商
              </div>
              <ProfileForm draft={draft} setDraft={setDraft} onSave={saveDraft} onCancel={cancelEdit} />
            </div>
          )}
        </div>
      </section>

      {/* ── General ── */}
      <section>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 14 }}>
          常规
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Field label="最大迭代次数">
            <input
              type="number"
              value={maxIterations}
              onChange={(e) => setField("maxIterations", parseInt(e.target.value) || 10)}
              min={1} max={50}
              style={inputStyle}
            />
          </Field>
          <Field label="上下文窗口（tokens，输入与输出合计）">
            <input
              type="number"
              value={contextTokensDraft}
              onChange={(e) => setContextTokensDraft(e.target.value)}
              min={1024} max={2000000} step={1}
              style={inputStyle}
            />
            <div style={{ fontSize: 12, opacity: 0.65 }}>8K 模型填 8192；不能超过模型服务实际启动的上下文大小。</div>
          </Field>


        </div>
      </section>

      <DesktopLiveSettings />

      <div style={{ marginTop: 28, display: "flex", gap: 14, alignItems: "center" }}>
        <button onClick={handleSaveGeneral} style={btnPrimaryStyle}>保存</button>
        <span style={{
          padding: "7px 14px",
          borderRadius: "var(--radius-sm)",
          fontSize: 12,
          fontWeight: 500,
          background: isConfigured ? "rgba(52,211,153,0.1)" : "rgba(255,255,255,0.04)",
          color: isConfigured ? "var(--success)" : "var(--text-muted)",
          border: `1px solid ${isConfigured ? "rgba(52,211,153,0.2)" : "var(--border-subtle)"}`,
        }}>
          {isConfigured ? "● 已连接" : "○ 未配置"}
        </span>
      </div>

      {notice && (
        <div style={{
          marginTop: 12,
          padding: "10px 12px",
          borderRadius: "var(--radius-sm)",
          border: noticeType === "success" ? "1px solid rgba(52,211,153,0.35)" : "1px solid rgba(244,63,94,0.35)",
          background: noticeType === "success" ? "rgba(52,211,153,0.08)" : "rgba(244,63,94,0.08)",
          color: noticeType === "success" ? "var(--success)" : "var(--danger)",
          fontSize: 13,
        }}>
          {notice}
        </div>
      )}
    </div>
  );
}

// ── ProfileForm ──────────────────────────────────────────────────────────────

interface ProfileFormProps {
  draft: Omit<ModelProfile, "id">;
  setDraft: React.Dispatch<React.SetStateAction<Omit<ModelProfile, "id">>>;
  onSave: () => void;
  onCancel: () => void;
}

function ProfileForm({ draft, setDraft, onSave, onCancel }: ProfileFormProps) {
  const set = (key: keyof typeof draft, val: string) =>
    setDraft((d) => {
      const next = { ...d, [key]: val };
      if (key === "provider" && !d.modelId) {
        next.modelId = PROVIDER_DEFAULT_MODELS[val] ?? "";
      }
      return next;
    });

  return (
    <div style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="名称">
          <input value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="我的 Claude" style={inputStyle} />
        </Field>
        <Field label="提供商">
          <select
            value={draft.provider}
            onChange={(e) => {
              set("provider", e.target.value);
              set("modelId", PROVIDER_DEFAULT_MODELS[e.target.value] ?? "");
            }}
            style={inputStyle}
          >
            {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
        </Field>
      </div>
      <Field label="模型 ID">
        <input value={draft.modelId} onChange={(e) => set("modelId", e.target.value)} placeholder="claude-sonnet-4-6" style={inputStyle} />
      </Field>
      <Field label="API 密钥">
        <input type="password" value={draft.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder="sk-..." style={inputStyle} />
      </Field>
      <Field label="接口地址（可选）">
        <input value={draft.baseUrl} onChange={(e) => set("baseUrl", e.target.value)} placeholder="https://api.anthropic.com" style={inputStyle} />
      </Field>
      <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
        <button onClick={onSave} style={btnPrimaryStyle}>保存</button>
        <button onClick={onCancel} style={btnSecondaryStyle}>取消</button>
      </div>
    </div>
  );
}

// ── Shared helpers ───────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{
        display: "block",
        fontSize: 12,
        color: "var(--text-secondary)",
        marginBottom: 6,
        fontWeight: 500,
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}>
        {label}
      </label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "9px 12px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)",
  background: "var(--bg-glass)",
  color: "var(--text-primary)",
  fontSize: 14,
  outline: "none",
  fontFamily: "var(--font-body)",
  backdropFilter: "blur(8px)",
  WebkitBackdropFilter: "blur(8px)",
  boxSizing: "border-box",
};

const btnPrimaryStyle: React.CSSProperties = {
  padding: "11px 28px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid transparent",
  background: "var(--accent)",
  color: "var(--text-inverse)",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "var(--font-body)",
  boxShadow: "0 2px 16px var(--accent-glow)",
  transition: "transform 0.15s var(--ease-out), box-shadow 0.15s var(--ease-out)",
};

const btnSecondaryStyle: React.CSSProperties = {
  padding: "11px 16px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)",
  background: "var(--bg-glass)",
  color: "var(--text-secondary)",
  fontSize: 14,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "var(--font-body)",
  whiteSpace: "nowrap",
  transition: "all 0.15s var(--ease-out)",
};

const btnSmallStyle: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid var(--border-default)",
  background: "var(--bg-glass)",
  color: "var(--text-secondary)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  fontFamily: "var(--font-body)",
};

const btnXsStyle: React.CSSProperties = {
  padding: "4px 10px",
  borderRadius: 6,
  border: "1px solid var(--border-subtle)",
  background: "transparent",
  color: "var(--text-muted)",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "var(--font-body)",
};
