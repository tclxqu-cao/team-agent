import { useEffect, useState, type ComponentProps } from "react";
import { Plus, X, Crown, Users, ChevronDown, FolderOpen } from "lucide-react";
import {
  COLLABORATION_AGENTS,
  type CollaborationGroup,
  type CollaborationMember,
} from "../../../../core/src/domain/collaboration/types";
import type { RuntimeHealth, RuntimeModelInfo } from "../../global";
import { isWebShell } from "../../web/webLayout";
import HostProjectPicker from "../HostProjectPicker";
import { AGENT_NAMES, collaborationRequest } from "./client";
import type { MonitoredSession } from "../../../../core/src/domain/supervision/types";
import MonitoredSessionPicker from "./MonitoredSessionPicker";
import "./collaboration.css";

function CollaborationSelect({ children, ...props }: ComponentProps<"select">) {
  return (
    <span className="collab-select">
      <select {...props}>{children}</select>
      <ChevronDown size={16} aria-hidden="true" />
    </span>
  );
}

function newMember(index: number): CollaborationMember {
  return {
    id: crypto.randomUUID(),
    name: index === 0 ? "群主" : `成员 ${index}`,
    agentType: "codex",
    role: "",
  };
}
function MemberEditor({
  member,
  index,
  owner,
  supervisor,
  health,
  onChange,
  onRemove,
}: {
  member: CollaborationMember;
  index: number;
  owner: boolean;
  supervisor?: boolean;
  health: RuntimeHealth[];
  onChange: (m: CollaborationMember) => void;
  onRemove?: () => void;
}) {
  const [models, setModels] = useState<RuntimeModelInfo[]>([]);
  const [profiles, setProfiles] = useState<
    Array<{ id: string; name: string; modelId: string }>
  >([]);
  useEffect(() => {
    let live = true;
    setModels([]);
    setProfiles([]);
    if (member.agentType === "customer-agent") {
      void window.agentApi
        .getSettings()
        .then((settings) => {
          if (live)
            setProfiles(
              settings.profiles.map(({ id, name, modelId }) => ({
                id,
                name,
                modelId,
              })),
            );
        })
        .catch(() => undefined);
      return () => {
        live = false;
      };
    }
    void window.agentApi
      .listAgentModels(member.agentType)
      .then((result) => {
        if (live) setModels(result.models);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [member.agentType]);
  return (
    <fieldset className="collab-member-editor">
      <legend>
        {owner ? <Crown size={14} /> : <Users size={14} />}
        {owner ? "群主" : `成员 ${index}`}{supervisor ? " · 监工" : ""}
      </legend>
      {onRemove && (
        <button
          type="button"
          className="collab-remove"
          aria-label={`移除${member.name}`}
          onClick={onRemove}
        >
          <X size={16} />
        </button>
      )}
      <div className="collab-editor-fields">
        <label>
          名称
          <input
            value={member.name}
            maxLength={100}
            onChange={(e) => onChange({ ...member, name: e.target.value })}
            required
          />
        </label>
        <label>
          Agent
          <CollaborationSelect
            value={member.agentType}
            onChange={(e) =>
              onChange({
                ...member,
                agentType: e.target.value as CollaborationMember["agentType"],
                model: undefined,
                profileId: undefined,
              })
            }
          >
            {COLLABORATION_AGENTS.map((type) => (
              <option
                key={type}
                value={type}
                disabled={
                  health.find((h) => h.agentType === type)?.available === false
                }
              >
                {AGENT_NAMES[type]}
                {health.find((h) => h.agentType === type)?.available === false
                  ? " · 不可用"
                  : ""}
              </option>
            ))}
          </CollaborationSelect>
        </label>
        <label className="collab-model-field">
          模型
          {member.agentType === "customer-agent" ? (
            <CollaborationSelect
              value={member.profileId || ""}
              onChange={(e) => {
                const profile = profiles.find(
                  (profile) => profile.id === e.target.value,
                );
                onChange({
                  ...member,
                  profileId: profile?.id,
                  model: profile ? { id: profile.modelId } : undefined,
                });
              }}
            >
              <option value="">沿用默认模型</option>
              {profiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name} · {profile.modelId}
                </option>
              ))}
            </CollaborationSelect>
          ) : (
            <CollaborationSelect
              value={
                member.model
                  ? `${member.model.providerID || ""}|${member.model.id}`
                  : ""
              }
              onChange={(e) => {
                const selected = models.find(
                  (m) => `${m.providerID || ""}|${m.id}` === e.target.value,
                );
                onChange({
                  ...member,
                  model: selected
                    ? {
                        id: selected.id,
                        ...(selected.providerID
                          ? { providerID: selected.providerID }
                          : {}),
                      }
                    : undefined,
                });
              }}
            >
              <option value="">沿用默认模型</option>
              {models.map((m) => (
                <option
                  key={`${m.providerID}|${m.id}`}
                  value={`${m.providerID || ""}|${m.id}`}
                >
                  {m.displayName || m.id}
                  {m.providerDisplayName ? ` · ${m.providerDisplayName}` : ""}
                </option>
              ))}
            </CollaborationSelect>
          )}
        </label>
      </div>
      <details className="collab-role-options" open={supervisor || undefined}>
        <summary>
          <span>定位与职责</span>
          <span className="collab-muted">
            {member.role.trim()
              ? "已设置"
              : owner
                ? "默认安排与汇总"
                : "留空由群主分配"}
          </span>
          <ChevronDown size={14} />
        </summary>
        <textarea
          aria-label={`${owner ? "群主" : `成员 ${index}`}的定位与职责（选填）`}
          rows={2}
          maxLength={8000}
          value={member.role}
          placeholder={
            supervisor
              ? "重点看什么：异常暂停、任务交接和交付。允许怎么处理：原任务内自动恢复、继续、协调交接；业务取舍或无法恢复时提醒我决策。"
              : owner
              ? "负责拆解目标、分配任务、验收和汇总成果"
              : "例如：负责实现接口；留空由群主自动分配"
          }
          onChange={(e) => onChange({ ...member, role: e.target.value })}
        />
        {supervisor && <p className="collab-muted">在职责中写明关注内容、判断标准、允许的恢复与交接，以及何时提醒你或等待决策。</p>}
      </details>
    </fieldset>
  );
}

export default function CollaborationCreateDialog({
  cwd,
  initialGroup,
  health,
  onClose,
  onCreated,
}: {
  cwd?: string;
  initialGroup?: CollaborationGroup;
  health: RuntimeHealth[];
  onClose: () => void;
  onCreated: (group: CollaborationGroup) => void;
}) {
  const [name, setName] = useState(initialGroup?.name || "");
  const [directory, setDirectory] = useState(initialGroup?.cwd || cwd || "");
  const [members, setMembers] = useState(() =>
    initialGroup
      ? structuredClone(initialGroup.members)
      : [newMember(0), newMember(1)],
  );
  const [ownerId, setOwnerId] = useState(
    initialGroup?.ownerId || members[0].id,
  );
  const [parallel, setParallel] = useState(initialGroup?.maxParallel || 3);
  const [targets, setTargets] = useState<MonitoredSession[]>(() => structuredClone(initialGroup?.monitoring?.targets ?? []));
  const [supervisorId, setSupervisorId] = useState(initialGroup ? initialGroup.monitoring?.supervisorId ?? "" : members[0].id);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [directoryPickerOpen, setDirectoryPickerOpen] = useState(false);
  const [directoryChosen, setDirectoryChosen] = useState(!!initialGroup?.cwd);
  const [choosingDirectory, setChoosingDirectory] = useState(false);
  const chooseDirectory = async () => {
    setError("");
    if (isWebShell()) {
      setDirectoryPickerOpen(true);
      return;
    }
    setChoosingDirectory(true);
    try {
      const selected = await window.agentApi.openFileDialog();
      if (selected) {
        setDirectory(selected);
        setDirectoryChosen(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "无法选择工作目录");
    } finally {
      setChoosingDirectory(false);
    }
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !busy &&
        !directoryPickerOpen &&
        !choosingDirectory
      )
        onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose, busy, directoryPickerOpen, choosingDirectory]);
  return (
    <div
      className="collab-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="collab-create"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collab-create-title"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            if (!directory.trim()) throw new Error("请先选择工作目录");
            const unavailable = members.find(
              (m) =>
                health.find((h) => h.agentType === m.agentType)?.available ===
                false,
            );
            if (unavailable && !initialGroup)
              throw new Error(`${unavailable.name} 选择的 Agent 当前不可用`);
            const group = await collaborationRequest<CollaborationGroup>({
              ...(initialGroup
                ? { action: "updateGroup" as const, groupId: initialGroup.id }
                : { action: "createGroup" as const }),
              group: {
                name: name.trim() || "协作群",
                // Workspaces belong to different runtimes; their IDs are not shared.
                cwd: directory.trim(),
                ownerId,
                members,
                maxParallel: Math.min(parallel, members.length),
                ...(targets.length ? { monitoring: { targets, ...(supervisorId ? { supervisorId } : {}) } } : {}),
              },
            });
            onCreated(group);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <header>
          <div>
            <span className="collab-eyebrow">一起完成一件事</span>
            <h2 id="collab-create-title">
              {initialGroup ? "修改协作群" : "拉个协作群"}
            </h2>
          </div>
          <button
            type="button"
            aria-label="关闭群设置"
            onClick={onClose}
            disabled={busy}
          >
            <X size={20} />
          </button>
        </header>
        <div className="collab-create-scroll">
          <div className="collab-group-fields">
            <label>
              <span>群名称</span>
              <input
                autoFocus
                value={name}
                maxLength={100}
                placeholder="例如：产品开发小组"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              <span>工作目录</span>
              <button
                type="button"
                className="collab-directory-picker"
                aria-label="选择工作目录"
                aria-haspopup="dialog"
                aria-expanded={directoryPickerOpen}
                title={directory || "选择工作目录"}
                disabled={busy || choosingDirectory}
                onClick={() => void chooseDirectory()}
              >
                <FolderOpen size={16} aria-hidden="true" />
                <span className={directory ? undefined : "collab-muted"}>
                  {choosingDirectory ? "正在选择…" : directory || "选择工作目录"}
                </span>
                <Plus size={16} aria-hidden="true" />
              </button>
            </label>
          </div>
          <p className="collab-create-hint collab-muted">
            {initialGroup
              ? "配置保存后用于新讨论，已有讨论和聊天记录保留。"
              : "Agent 可重复加入，职责留空由群主分配。"}
          </p>
          {members.map((member, index) => (
            <MemberEditor
              key={member.id}
              member={member}
              index={index}
              owner={member.id === ownerId}
              supervisor={targets.length > 0 && member.id === supervisorId}
              health={health}
              onChange={(next) =>
                setMembers((current) =>
                  current.map((m) => (m.id === next.id ? next : m)),
                )
              }
              onRemove={
                member.id !== ownerId && members.length > 2
                  ? () => {
                      if (member.id === supervisorId) setSupervisorId("");
                      setMembers((current) =>
                        current.filter((m) => m.id !== member.id),
                      )
                    }
                  : undefined
              }
            />
          ))}
          <div className="collab-create-actions">
            <label>
              群主
              <CollaborationSelect
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </CollaborationSelect>
            </label>
            <button
              type="button"
              disabled={members.length >= 20}
              onClick={() =>
                setMembers((current) => [...current, newMember(current.length)])
              }
            >
              <Plus size={16} />
              添加成员
            </button>
            <label>
              最多同时工作
              <CollaborationSelect
                value={Math.min(parallel, members.length)}
                onChange={(e) => setParallel(Number(e.target.value))}
              >
                {members.map((_, i) => (
                  <option key={i + 1} value={i + 1}>
                    {i + 1} 人
                  </option>
                ))}
              </CollaborationSelect>
            </label>
          </div>
          <MonitoredSessionPicker value={targets} onChange={setTargets}/>
          {targets.length > 0 && <label className="collab-supervisor-select">监工
            <CollaborationSelect aria-label="选择监工成员" value={supervisorId} onChange={event => setSupervisorId(event.target.value)}>
              <option value="">仅关联，不启用监工</option>
              {members.map(member => <option value={member.id} key={member.id}>{member.name} · {AGENT_NAMES[member.agentType]}</option>)}
            </CollaborationSelect>
            <small className="collab-muted">复用该成员的 Agent、模型和职责，关闭看板后继续监管。</small>
          </label>}
        </div>
        {error && (
          <p className="collab-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <span className="collab-muted">
            职责可以留空，发送任务后由群主分配。
          </span>
          <button
            className="collab-primary"
            disabled={busy || choosingDirectory || !directory.trim()}
            type="submit"
          >
            {busy ? "正在保存…" : initialGroup ? "保存修改" : "创建并打开群"}
          </button>
        </footer>
      </form>
      <HostProjectPicker
        open={directoryPickerOpen}
        initialPath={directoryChosen ? directory : undefined}
        onCancel={() => setDirectoryPickerOpen(false)}
        onConfirm={(path) => {
          setDirectory(path);
          setDirectoryChosen(true);
          setDirectoryPickerOpen(false);
          setError("");
        }}
      />
    </div>
  );
}
