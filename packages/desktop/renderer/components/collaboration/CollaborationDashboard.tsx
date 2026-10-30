import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowRight,
  Crown,
  Folder,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import type { CollaborationGroup } from "@agent/core/domain/collaboration/types";
import {
  COLLABORATION_CHANGED_TYPE,
  COLLABORATION_OPEN_TYPE,
  COLLABORATION_DASHBOARD_READY_TYPE,
} from "../../../../core/src/domain/web-console/CollaborationTabBridge";
import type { RuntimeHealth } from "../../global";
import AgentBrandIcon from "../AgentBrandIcon";
import { useUIStore } from "../../stores/uiStore";
import CollaborationCreateDialog from "./CollaborationCreateDialog";
import { useCollaborationGroups } from "./useCollaborationGroups";
import { AGENT_NAMES, collaborationRequest } from "./client";
import { postDashboardIntent } from "../../../../core/src/domain/web-console/SessionDashboardBridge";
import "./collaboration.css";
import "./dashboard.css";

export default function CollaborationDashboard({
  onOpen,
  onChanged,
  onClose,
  cwd,
}: {
  onOpen?: (group: CollaborationGroup) => void;
  onChanged?: (groupId: string, group?: CollaborationGroup) => void;
  onClose?: () => void;
  cwd?: string;
}) {
  const { groups, loading, error, refresh } = useCollaborationGroups();
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<CollaborationGroup | "new" | null>(null);
  const [deleting, setDeleting] = useState<CollaborationGroup | null>(null);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState("");
  const [health, setHealth] = useState<RuntimeHealth[]>([]);
  const skin = useUIStore((s) => s.skin);
  useEffect(() => {
    if (!loading && window.parent !== window)
      window.parent.postMessage(
        { type: COLLABORATION_DASHBOARD_READY_TYPE },
        window.location.origin,
      );
  }, [loading]);
  useEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
  }, [skin]);
  useEffect(() => {
    let live = true;
    void window.agentApi
      .getRuntimeHealth()
      .then((list) => {
        if (live) setHealth(list);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  const open = (group: CollaborationGroup) => {
    if (onOpen) onOpen(group);
    else if (window.parent !== window)
      window.parent.postMessage(
        { type: COLLABORATION_OPEN_TYPE, groupId: group.id, title: group.name },
        window.location.origin,
      );
    else
      location.assign(
        `?view=collaboration&groupId=${encodeURIComponent(group.id)}`,
      );
  };
  const changed = (groupId: string, group?: CollaborationGroup) => {
    onChanged?.(groupId, group);
    if (window.parent !== window)
      window.parent.postMessage(
        {
          type: COLLABORATION_CHANGED_TYPE,
          groupId,
          ...(group ? { title: group.name } : { deleted: true }),
        },
        window.location.origin,
      );
    void refresh();
  };
  const filtered = groups.filter((group) =>
    `${group.name} ${group.cwd} ${group.members.map((m) => m.name).join(" ")}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <main className="collab-dashboard">
      <header className="collab-dashboard-heading">
        <div>
          <span className="collab-eyebrow">协作空间</span>
          <h1>
            群聊列表 <small>{groups.length}</small>
          </h1>
          <p className="collab-muted">找到你的群，继续上次的协作。</p>
        </div>
        <div className="collab-dashboard-tools">
          <button onClick={() => postDashboardIntent({ kind: "dashboard" })}>Dashboard</button>
          <button
            aria-label="刷新群列表"
            title="刷新群列表"
            disabled={loading}
            onClick={() => void refresh()}
          >
            <RefreshCw size={17} />
          </button>
          <button className="collab-primary" onClick={() => setEditor("new")}>
            <Plus size={17} />
            新增群聊
          </button>
          {onClose && (
            <button aria-label="关闭群看板" onClick={onClose}>
              <X size={18} />
            </button>
          )}
        </div>
      </header>
      <label className="collab-dashboard-search">
        <Search size={17} />
        <input
          aria-label="搜索群聊"
          placeholder="搜索群名、成员或工作目录"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>
      {error && (
        <div className="collab-error" role="alert">
          {error}
          <button onClick={() => void refresh()}>重试</button>
        </div>
      )}
      {loading && groups.length === 0 ? (
        <div className="collab-dashboard-empty" role="status">
          正在加载已保存的群…
        </div>
      ) : !error && filtered.length === 0 ? (
        <div className="collab-dashboard-empty">
          <Users size={32} />
          <h2>{query ? "没有找到匹配的群" : "还没有协作群"}</h2>
          <p>
            {query ? "换个关键词试试。" : "选一位群主和成员，一起完成任务。"}
          </p>
          {!query && (
            <button className="collab-primary" onClick={() => setEditor("new")}>
              <Plus size={16} />
              新建第一个群
            </button>
          )}
        </div>
      ) : (
        <section
          className="collab-dashboard-grid"
          aria-label="已保存的群聊"
          aria-busy={loading}
        >
          {filtered.map((group) => {
            const owner = group.members.find((m) => m.id === group.ownerId);
            return (
              <article className="collab-group-card" key={group.id}>
                <div className="collab-card-heading">
                  <button
                    className="collab-card-title"
                    onClick={() => open(group)}
                    title={group.name}
                  >
                    <Users size={20} />
                    <h2>{group.name}</h2>
                  </button>
                  <div className="collab-card-actions">
                    <button
                      aria-label={`修改${group.name}`}
                      title="修改群设置"
                      onClick={() => setEditor(group)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      aria-label={`删除${group.name}`}
                      title="删除群聊"
                      onClick={() => {
                        setMutationError("");
                        setDeleting(group);
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
                <p className="collab-card-owner">
                  <Crown size={14} />
                  <span>群主 · {owner?.name}</span>
                  <span className="collab-muted">
                    {owner && AGENT_NAMES[owner.agentType]}
                  </span>
                </p>
                <div
                  className="collab-card-members"
                  aria-label={`${group.members.length} 名群成员`}
                >
                  {group.members.slice(0, 7).map((member) => (
                    <span
                      key={member.id}
                      title={`${member.name} · ${AGENT_NAMES[member.agentType]}`}
                    >
                      <AgentBrandIcon agentType={member.agentType} size={18} />
                    </span>
                  ))}
                  <small>
                    {group.members.length} 人 · 最多 {group.maxParallel} 人并行
                  </small>
                </div>
                <p className="collab-card-path" title={group.cwd}>
                  <Folder size={14} />
                  <span>{group.cwd}</span>
                </p>
                <footer>
                  <time dateTime={group.createdAt}>
                    {new Date(group.createdAt).toLocaleDateString("zh-CN")} 创建
                  </time>
                  <button onClick={() => open(group)}>
                    进入群聊
                    <ArrowRight size={16} />
                  </button>
                </footer>
              </article>
            );
          })}
        </section>
      )}
      {editor &&
        createPortal(
          <CollaborationCreateDialog
            key={editor === "new" ? "new" : editor.id}
            cwd={cwd}
            initialGroup={editor === "new" ? undefined : editor}
            health={health}
            onClose={() => setEditor(null)}
            onCreated={(group) => {
              const isNew = editor === "new";
              setEditor(null);
              changed(group.id, group);
              if (isNew) open(group);
            }}
          />,
          document.body,
        )}
      {deleting &&
        createPortal(
          <div className="collab-modal-backdrop">
            <section
              className="collab-delete-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="collab-delete-title"
              aria-describedby="collab-delete-description"
            >
              <h2 id="collab-delete-title">删除“{deleting.name}”？</h2>
              <p id="collab-delete-description">
                删除后将从看板移除，工作目录中的文件不会删除。进行中的协作需要先停止。
              </p>
              {mutationError && (
                <p className="collab-error" role="alert">
                  {mutationError}
                </p>
              )}
              <footer>
                <button
                  autoFocus
                  disabled={busy}
                  onClick={() => setDeleting(null)}
                >
                  取消
                </button>
                <button
                  className="collab-delete-confirm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setMutationError("");
                    try {
                      await collaborationRequest({
                        action: "deleteGroup",
                        groupId: deleting.id,
                      });
                      changed(deleting.id);
                      setDeleting(null);
                    } catch (err) {
                      setMutationError(
                        err instanceof Error ? err.message : String(err),
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {busy ? "正在删除…" : "确认删除"}
                </button>
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </main>
  );
}
