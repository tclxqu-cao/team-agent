import { Users } from "lucide-react";
import type { CollaborationGroup } from "../../../../core/src/domain/collaboration/types";
import type { SupervisionMessage } from "../../../../core/src/domain/supervision/types";
import AgentBrandIcon from "../AgentBrandIcon";
import CollaborationMessageText from "./CollaborationMessageText";
import { AGENT_NAMES } from "./client";

function participantAgent(message: SupervisionMessage, group: CollaborationGroup, side: "sender" | "recipient") {
  const saved = side === "sender" ? message.senderAgentType : message.recipientAgentType;
  if (saved) return saved;
  const name = message[side];
  if (!name || name === "你" || name === group.name) return undefined;
  // Older journal entries contain labels only. Use the source session before
  // member names, since a monitored session may share a member's display name.
  const sessionSide = message.direction === "received" ? "sender" : message.direction === "sent" ? "recipient" : undefined;
  if (side === sessionSide) {
    const targets = group.monitoring?.targets.filter(target =>
      (message.sessionId ? target.id === message.sessionId : target.title === name)
      && (name === message.sessionTitle || name === target.title)) ?? [];
    if (targets.length === 1) return targets[0].agentType;
  }
  const members = group.members.filter(member => member.name === name);
  if (members.length === 1) return members[0].agentType;
  if (name === "监工") return group.members.find(member => member.id === group.monitoring?.supervisorId)?.agentType;
  return undefined;
}

export default function SupervisionMessageItem({ message, group }: { message: SupervisionMessage; group: CollaborationGroup }) {
  const senderType = participantAgent(message, group, "sender");
  const recipientType = participantAgent(message, group, "recipient");
  const senderLabel = senderType ? `${message.sender} · ${AGENT_NAMES[senderType]}` : message.sender;
  const recipientLabel = recipientType ? `${message.recipient} · ${AGENT_NAMES[recipientType]}` : message.recipient;
  const isUser = message.sender === "你" && !senderType;
  const direction = message.direction === "received" ? "收到消息" : message.direction === "sent" ? "发出消息" : "监工动态";
  return <article className={`collab-message collab-supervision-message is-${message.direction}`} data-supervision-message={message.id} aria-label={`${direction}：${message.title}`}>
    <span className={`collab-avatar collab-supervision-avatar${isUser ? " collab-avatar--user" : ""}`} role="img" aria-label={senderLabel} title={senderLabel}>
      {senderType ? <AgentBrandIcon agentType={senderType} size={20}/> : isUser ? "你" : <Users size={18} aria-hidden="true"/>}
    </span>
    <div className="collab-message-body">
      <div className="collab-supervision-message-heading"><strong>{message.title}</strong><span>{message.historical ? "历史监工记录" : direction}</span></div>
      <div className="collab-supervision-message-route" aria-label={`${message.sender}${message.recipient ? ` → ${message.recipient}` : ""}`}>
        <span className="collab-supervision-participant" title={senderLabel}>{senderType && <AgentBrandIcon agentType={senderType} size={13}/>}<span>{message.sender}</span></span>
        {message.recipient && <><span aria-hidden="true">→</span><span className="collab-supervision-participant" title={recipientLabel}>{recipientType && <AgentBrandIcon agentType={recipientType} size={13}/>}<span>{message.recipient}</span></span></>}
      </div>
      {message.sessionTitle && <div className="collab-supervision-message-source" title={message.sessionTitle}>来源会话：{message.sessionTitle}</div>}
      <CollaborationMessageText text={message.content} cwd={message.cwd || group.cwd}/>
    </div>
    <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString("zh-CN")}>{new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time>
  </article>;
}
