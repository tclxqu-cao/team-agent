import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  Clock3,
  Crown,
  History,
  LoaderCircle,
  Menu,
  Plus,
  Square,
  Users,
  X,
} from "lucide-react";
import type { CollaborationMember, CollaborationMessage } from "@agent/core/domain/collaboration/types";
import AgentBrandIcon from "../AgentBrandIcon";
import { useUIStore } from "../../stores/uiStore";
import CollaborationMessageText from "./CollaborationMessageText";
import { AGENT_NAMES, DISCUSSION_STATUS, collaborationRequest } from "./client";
import { useCollaborationDiscussion } from "./useCollaborationDiscussion";
import { COLLABORATION_CONTENT_READY_TYPE } from "../../../../core/src/domain/web-console/CollaborationTabBridge";
import "./collaboration.css";

function CollaborationAvatar({ member, isUser = false, isOwner = false }: {
  member?: CollaborationMember;
  isUser?: boolean;
  isOwner?: boolean;
}) {
  const label = isUser ? "你" : member
    ? `${member.name} · ${AGENT_NAMES[member.agentType]}${isOwner ? " · 群主" : ""}`
    : "协作动态";
  return <span className={`collab-avatar${isUser ? " collab-avatar--user" : ""}`} role="img" aria-label={label} title={label}>
    {isUser ? "你" : member ? <AgentBrandIcon agentType={member.agentType} size={20} /> : <Users size={18} aria-hidden="true" />}
    {isOwner && <Crown className="collab-avatar-crown" size={13} aria-hidden="true" />}
  </span>;
}

function Question({
  message,
  discussionId,
  onError,
}: {
  message: CollaborationMessage;
  discussionId: string;
  onError: (text: string) => void;
}) {
  const [answer, setAnswer] = useState(""),
    [busy, setBusy] = useState(false);
  if (!message.question || message.question.resolved)
    return (
      <span className="collab-muted">
        <Check size={12} /> 已处理
      </span>
    );
  const submit = async (value: string, index?: number) => {
    setBusy(true);
    try {
      await collaborationRequest({
        action: "answer",
        discussionId,
        questionId: message.question!.id,
        answer: value,
        ...(index === undefined ? {} : { selectedIndices: [index] }),
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="collab-question">
      {message.question.options?.map((option, index) => (
        <button
          key={index}
          disabled={busy}
          onClick={() => {
            void submit(option.label, index);
          }}
          title={option.description}
        >
          {option.label}
        </button>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (answer.trim()) void submit(answer);
        }}
      >
        <input
          aria-label="回答成员问题"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          placeholder="输入回复"
        />
        <button disabled={busy || !answer.trim()}>回复</button>
      </form>
    </div>
  );
}

export default function CollaborationPage({
  groupId: provided,
}: {
  groupId?: string;
}) {
  const groupId =
    provided || new URLSearchParams(location.search).get("groupId") || "";
  const {
    group,
    history,
    selected,
    discussion,
    error,
    busy,
    select,
    create,
    act,
    send,
    setError,
    updateRole,
  } = useCollaborationDiscussion(groupId);
  const [draft, setDraft] = useState(""),
    [drawer, setDrawer] = useState(false),
    [detailMember, setDetailMember] = useState<string | null>(null);
  const skin = useUIStore((s) => s.skin);
  useEffect(() => {
    document.documentElement.setAttribute("data-skin", skin);
  }, [skin]);
  const contentReady = !!error || (!!group && (!selected || !!discussion));
  useEffect(() => {
    if (contentReady && window.parent !== window)
      window.parent.postMessage(
        { type: COLLABORATION_CONTENT_READY_TYPE, groupId },
        window.location.origin,
      );
  }, [contentReady, groupId]);
  const end = useRef<HTMLDivElement>(null),
    scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const pendingMessage = useRef<{ text: string; id: string } | null>(null);
  const drafts = useRef(new Map<string, string>());
  useEffect(() => {
    if (follow.current) end.current?.scrollIntoView({ block: "end" });
  }, [discussion?.messages.length, selected]);
  useEffect(() => {
    follow.current = true;
  }, [selected]);
  if (!group)
    return (
      <div className="collab-loading">
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <>
            <LoaderCircle className="collab-spin" />
            正在打开协作群…
          </>
        )}
      </div>
    );
  const owner = group.members.find((m) => m.id === group.ownerId)!;
  const activeTasks =
    discussion?.tasks.filter((t) => t.status === "running") || [];
  const queuedTasks =
    discussion?.status === "running"
      ? discussion.tasks.filter((t) => t.status === "queued")
      : [];
  const workspaceWaitingTasks = queuedTasks.filter(
    (t) => t.result === "等待工作目录空闲",
  );
  const arranging =
    discussion?.planning ||
    (discussion?.status === "running" &&
      discussion.ownerPending &&
      activeTasks.length === 0);
  const isQueued =
    !arranging && activeTasks.length === 0 && queuedTasks.length > 0;
  const queuedStatus =
    workspaceWaitingTasks.length > 0
      ? `${workspaceWaitingTasks.length} 个任务等待工作目录空闲，空闲后会自动继续。`
      : "任务排队中，等待前置任务完成。";
  const discussionStatus = isQueued
    ? workspaceWaitingTasks.length > 0
      ? "等待工作目录空闲"
      : "任务排队中"
    : discussion
      ? DISCUSSION_STATUS[discussion.status]
      : "准备好了";
  const shownMessages =
    discussion?.messages.filter((m) => m.kind !== "progress") || [];
  const switchDiscussion = (id: string) => {
    drafts.current.set(selected || "new", draft);
    setDraft(drafts.current.get(id) || "");
    pendingMessage.current = null;
    select(id);
    setDrawer(false);
    follow.current = true;
  };
  const newDiscussion = async () => {
    try {
      drafts.current.set(selected || "new", draft);
      if (await create()) {
        setDraft("");
        pendingMessage.current = null;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  const submit = async () => {
    if (!draft.trim() || busy) return;
    if (!pendingMessage.current || pendingMessage.current.text !== draft)
      pendingMessage.current = { text: draft, id: crypto.randomUUID() };
    if (await send(draft, pendingMessage.current.id)) {
      setDraft("");
      pendingMessage.current = null;
      follow.current = true;
    }
  };
  return (
    <div className="collab-page">
      {drawer && (
        <button
          className="collab-drawer-mask"
          aria-label="关闭成员栏"
          onClick={() => setDrawer(false)}
        />
      )}
      <aside className={`collab-sidebar${drawer ? " is-open" : ""}`}>
        <header className="collab-sidebar-heading">
          <div className="collab-group-icon">
            <Users size={22} />
          </div>
          <div>
            <span className="collab-eyebrow">
              协作群 · {group.members.length} 人
            </span>
            <h2>{group.name}</h2>
          </div>
          <button
            className="collab-mobile-close"
            aria-label="收起群成员"
            onClick={() => setDrawer(false)}
          >
            <X size={18} />
          </button>
        </header>
        <div className="collab-roster" aria-label="群成员">
          <span className="collab-section-label">群成员</span>
          {[owner, ...group.members.filter((m) => m.id !== owner.id)].map(
            (member) => {
              const task = activeTasks.find((t) => t.memberId === member.id),
                planning = member.id === owner.id && discussion?.planning;
              const queued = queuedTasks.find((t) => t.memberId === member.id);
              const questions = discussion?.messages.some(
                (m) =>
                  m.memberId === member.id &&
                  m.question &&
                  !m.question.resolved,
              );
              const status = questions
                ? "等待你回复"
                : planning
                  ? "正在安排"
                  : task
                    ? "正在执行"
                    : queued
                      ? queued.result === "等待工作目录空闲"
                        ? "等待目录空闲"
                        : "排队中"
                      : "空闲";
              return (
                <div
                  key={member.id}
                  className={`collab-roster-member${planning || task ? " is-working" : ""}`}
                >
                  <button
                    onClick={() =>
                      setDetailMember((current) =>
                        current === member.id ? null : member.id,
                      )
                    }
                    aria-expanded={detailMember === member.id}
                  >
                    <CollaborationAvatar member={member} isOwner={member.id === owner.id} />
                    <span className="collab-member-name">
                      <strong>
                        {member.name}
                      </strong>
                      <small>{AGENT_NAMES[member.agentType]}</small>
                    </span>
                    <span className="collab-member-status">{status}</span>
                  </button>
                  <p>
                    {member.role ||
                      discussion?.roles[member.id] ||
                      "等待群主分配定位"}
                  </p>
                  {detailMember === member.id && (
                    <div className="collab-member-detail">
                      <small>{member.model?.id || "默认模型"}</small>
                      <form
                        className="collab-role-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const role = new FormData(e.currentTarget).get(
                            "role",
                          );
                          void updateRole(member.id, String(role || "")).catch(
                            (err) => setError(err.message),
                          );
                        }}
                      >
                        <label>
                          定位与职责
                          <textarea
                            key={member.role}
                            name="role"
                            defaultValue={member.role}
                            rows={3}
                            maxLength={8000}
                            placeholder="留空由群主分配"
                          />
                        </label>
                        <button type="submit">保存职责</button>
                      </form>
                      {discussion?.tasks
                        .filter((t) => t.memberId === member.id)
                        .map((t) => (
                          <div key={t.id}>
                            {t.title}
                            <span>
                              {t.status === "completed"
                                ? "已完成"
                                : t.status === "running"
                                  ? "执行中"
                                  : t.status === "queued"
                                    ? "等待依赖或空闲"
                                    : t.status === "failed"
                                      ? "失败"
                                      : t.status === "cancelled"
                                        ? "已取消"
                                        : "已中断"}
                            </span>
                            {t.result && (
                              <details>
                                <summary>查看结果</summary>
                                <CollaborationMessageText
                                  text={t.result}
                                  cwd={t.cwd || group.cwd}
                                />
                              </details>
                            )}
                          </div>
                        ))}
                      {discussion?.messages
                        .filter(
                          (m) =>
                            m.memberId === member.id && m.kind === "progress",
                        )
                        .slice(-20)
                        .map((m) => (
                          <small key={m.id}>{m.content}</small>
                        ))}
                    </div>
                  )}
                </div>
              );
            },
          )}
        </div>
        <section className="collab-history" aria-label="群聊记录">
          <header>
            <span className="collab-section-label">
              <History size={13} />
              群聊记录
            </span>
            <button
              disabled={busy}
              aria-label="新建群讨论"
              title="新讨论"
              onClick={() => {
                void newDiscussion();
              }}
            >
              <Plus size={17} />
            </button>
          </header>
          <div className="collab-history-list">
            {history.length ? (
              history.map((item) => (
                <button
                  key={item.id}
                  className={selected === item.id ? "is-selected" : ""}
                  aria-current={selected === item.id ? "page" : undefined}
                  onClick={() => {
                    switchDiscussion(item.id);
                  }}
                >
                  <strong>{item.title}</strong>
                  <span>
                    <time>
                      {new Date(item.updatedAt).toLocaleDateString("zh-CN", {
                        month: "short",
                        day: "numeric",
                      })}
                    </time>
                    <small>{DISCUSSION_STATUS[item.status]}</small>
                  </span>
                </button>
              ))
            ) : (
              <p className="collab-muted">发送第一条任务，记录会保存在这里。</p>
            )}
          </div>
        </section>
        <footer className="collab-sidebar-footer" title={group.cwd}>
          {group.cwd}
        </footer>
      </aside>
      <main className="collab-conversation">
        <header className="collab-conversation-heading">
          <button
            className="collab-mobile-menu"
            aria-label="展开群成员和群聊记录"
            onClick={() => setDrawer(true)}
          >
            <Menu size={20} />
          </button>
          <div className="collab-discussion-title">
            <h1>{discussion?.title || "开始一起做事"}</h1>
            <span
              className="collab-discussion-status"
              data-status={isQueued ? "queued" : discussion?.status || "idle"}
              role="status"
              aria-label={discussionStatus}
              title={discussionStatus}
            />
          </div>
          <div className="collab-heading-actions">
            {discussion &&
              ["running", "waiting"].includes(discussion.status) && (
                <button
                  className="collab-heading-stop"
                  disabled={busy}
                  onClick={() => {
                    void act("stop");
                  }}
                >
                  <span className="collab-heading-action-content">
                    <Square size={12} fill="currentColor" strokeWidth={0} />
                    停止
                  </span>
                </button>
              )}
            {discussion &&
              ["waiting", "interrupted", "stopped"].includes(
                discussion.status,
              ) && (
                <button
                  className="collab-heading-resume"
                  disabled={busy}
                  onClick={() => {
                    void act("resume");
                  }}
                >
                  <span className="collab-heading-action-content">继续协作</span>
                </button>
              )}
            <button
              className="collab-heading-new"
              disabled={busy}
              onClick={() => {
                void newDiscussion();
              }}
            >
              <span className="collab-heading-action-content">
                <Plus size={14} />
                新讨论
              </span>
            </button>
          </div>
        </header>
        <div
          ref={scroller}
          className="collab-messages"
          onScroll={() => {
            const el = scroller.current;
            if (el)
              follow.current =
                el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          }}
        >
          {!shownMessages.length && (
            <div className="collab-empty">
              <span className="collab-empty-icon">
                <Users size={34} />
              </span>
              <h2>把目标交给这个群。</h2>
              <p>
                {owner.name}会安排分工，成员会在这里汇报进展。
                <br />
                你可以随时补充要求。
              </p>
              <div className="collab-empty-members">
                {group.members.map((m) => (
                  <span key={m.id}>
                    <AgentBrandIcon agentType={m.agentType} size={17} />
                    {m.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {shownMessages.map((message) => {
            const member = group.members.find((m) => m.id === message.memberId);
            return (
              <article
                key={message.id}
                className={`collab-message collab-message--${message.kind}`}
              >
                <CollaborationAvatar
                  member={member}
                  isUser={message.kind === "user"}
                  isOwner={message.kind !== "user" && member?.id === owner.id}
                />
                <div className="collab-message-body">
                  <CollaborationMessageText
                    text={message.content}
                    cwd={
                      discussion?.tasks.find((task) => task.id === message.taskId)
                        ?.cwd || group.cwd
                    }
                  />
                  {message.kind === "question" && selected && (
                    <Question
                      message={message}
                      discussionId={selected}
                      onError={setError}
                    />
                  )}
                </div>
                <time dateTime={message.createdAt}>
                  {new Date(message.createdAt).toLocaleTimeString("zh-CN", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </time>
              </article>
            );
          })}
          {(arranging || activeTasks.length > 0 || isQueued) && (
            <div
              className={`collab-live-status${isQueued ? " is-queued" : ""}`}
              role="status"
            >
              {isQueued ? (
                <Clock3 size={14} aria-hidden="true" />
              ) : (
                <LoaderCircle size={14} className="collab-spin" aria-hidden="true" />
              )}
              <span>
                {arranging
                  ? `${owner.name}正在安排下一步`
                  : isQueued
                    ? queuedStatus
                    : activeTasks
                        .map(
                          (t) =>
                            `${group.members.find((m) => m.id === t.memberId)?.name}：${t.title}`,
                        )
                        .join(" · ")}
              </span>
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="collab-composer-area">
          {error && (
            <p className="collab-error" role="alert">
              {error}
            </p>
          )}
          <div className="collab-composer">
            <textarea
              aria-label="发送群消息"
              value={draft}
              placeholder="告诉群主，你想完成什么…"
              rows={3}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing
                ) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <footer>
              <span>
                {discussion?.status === "running"
                  ? "补充要求会交给群主继续安排"
                  : "由群主安排分工与并行"}
              </span>
              <button
                aria-label="发送群消息"
                className="collab-primary"
                disabled={
                  busy || !draft.trim() || discussion?.status === "stopping"
                }
                onClick={() => {
                  void submit();
                }}
              >
                <ArrowUp size={20} />
              </button>
            </footer>
          </div>
          <small className="collab-composer-hint">
            Enter 发送 · Shift+Enter 换行 · 群聊记录自动保存
          </small>
        </div>
      </main>
    </div>
  );
}
