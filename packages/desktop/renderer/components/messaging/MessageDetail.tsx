import { useState } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { AgentType } from "../../../../core/src/domain/agent/agent-type";
import type { DeliveryRecord, MessageRecord, RoutingCandidate } from "../../../../core/src/domain/messaging/types";
import { DELIVERY_LABELS, EXECUTION_LABELS, timeLabel } from "./client";
import { postDashboardIntent } from "../../lib/dashboard-navigation-delivery";

export interface MessageDetailProps {
  message: MessageRecord;
  deliveries: DeliveryRecord[];
  candidates: RoutingCandidate[];
  busy?: boolean;
  onBack: () => void;
  onOpenSession?: (record: MessageRecord) => void;
  onResolve: (projectId: string, agentType: AgentType) => void;
  onRetry: (deliveryId: string) => void;
}
export default function MessageDetail({ message, deliveries, candidates, busy, onBack, onOpenSession, onResolve, onRetry }: MessageDetailProps) {
  const [projectId, setProjectId] = useState("");
  const [agentType, setAgentType] = useState<AgentType>("codex");
  const decision = message.routing.decision;
  const project = message.routing.candidates?.find(candidate => candidate.projectId === decision?.projectId);
  const selected = candidates.find(candidate => candidate.projectId === projectId);
  const original = typeof message.source.raw.displayText === "string" ? message.source.raw.displayText : message.source.text;
  return <article className="messaging-detail" aria-label="消息处理详情">
    <header className="messaging-detail-heading">
      <button type="button" onClick={onBack} aria-label="关闭消息详情"><ArrowLeft size={16}/>返回列表</button>
      <span className="messaging-mono">{message.id.slice(0, 8)}</span>
    </header>
    <section>
      <div className="messaging-section-label">收到的消息 <time>{timeLabel(message.source.occurredAt)}</time></div>
      <h2>{message.source.conversationName || message.source.conversationId}</h2>
      <p className="messaging-muted">发送者 {message.source.senderId} · {message.source.directMention ? "正文直接 @我" : "未直接 @我"}{message.source.ownMessage ? " · 本人消息" : ""}</p>
      <pre className="messaging-original">{original || "非文本或尚未识别的消息，展开原始数据查看"}</pre>
    </section>
    <section>
      <div className="messaging-section-label">路由判断 <span>{message.routing.confirmedByUser ? "用户确认" : message.routing.mode === "model" ? "模型判断" : "规则判断"}</span></div>
      {message.routing.initialDecision && <details><summary>查看最初判断</summary><p>{message.routing.initialDecision.model}</p><p>{message.routing.initialDecision.reason}</p></details>}
      {decision?.model && <p className="messaging-mono messaging-muted">{decision.model}</p>}
      <p>{decision?.reason || (message.routing.status === "routing" ? "正在判断执行目标…" : "等待判断执行目标")}</p>
      {!!message.routing.context?.length && <details><summary>判断时参考的近期消息</summary>{message.routing.context.map((item, index) => <pre key={index}>{item.text}{item.projectId ? "\n关联项目：" + item.projectId : ""}</pre>)}</details>}
      <dl className="messaging-destination">
        <div><dt>项目</dt><dd>{message.execution.projectName || project?.projectName || decision?.projectId || "尚未确定"}</dd></div>
        <div><dt>Agent</dt><dd>{decision?.agentType || "尚未确定"}</dd></div>
      </dl>
      {message.routing.status === "review" && <div className="messaging-resolve">
        <p>选择目标后继续执行</p>
        <select aria-label="确认项目" value={projectId} onChange={event => {
          setProjectId(event.target.value); setAgentType(candidates.find(item => item.projectId === event.target.value)?.agents[0] ?? "codex");
        }}><option value="">选择项目</option>{candidates.map(item => <option key={item.projectId} value={item.projectId}>{item.projectName}</option>)}</select>
        <select aria-label="确认 Agent" value={agentType} onChange={event => setAgentType(event.target.value as AgentType)}>
          {(selected?.agents ?? []).map(agent => <option key={agent} value={agent}>{agent}</option>)}
        </select>
        <button type="button" disabled={busy || !selected?.agents.includes(agentType)} onClick={() => onResolve(projectId, agentType)}>确认路由</button>
      </div>}
    </section>
    <section>
      <div className="messaging-section-label">会话执行 <span data-status={message.execution.status}>{EXECUTION_LABELS[message.execution.status]}</span></div>
      {message.execution.sessionId && <>
        <code className="messaging-session-id">{message.execution.sessionId}</code>
        {onOpenSession ? <button type="button" onClick={() => onOpenSession(message)}><ExternalLink size={14}/>打开会话</button>
          : <a className="messaging-session-link" href={"/app/?agent=" + encodeURIComponent(decision?.agentType ?? "codex") + "&session=" + encodeURIComponent(message.execution.sessionId)}
            onClick={event => {
              if (window.parent !== window && project && decision?.agentType && message.execution.sessionId) {
                event.preventDefault();
                postDashboardIntent({ kind: "session", session: { id: message.execution.sessionId, agentType: decision.agentType, title: message.source.conversationName, cwd: project.description, projectId: decision.projectId } });
              }
            }}><ExternalLink size={14}/>打开会话</a>}
      </>}
      {message.execution.runId && <p className="messaging-muted messaging-mono">运行 {message.execution.runId}</p>}
      {message.execution.error && <p className="messaging-inline-error">{message.execution.error}</p>}
      {message.execution.result && <pre className="messaging-result">{message.execution.result}</pre>}
    </section>
    <section>
      <div className="messaging-section-label">结果回传 <span>{deliveries.length} 个投递记录</span></div>
      {!deliveries.length && <p className="messaging-muted">尚未生成需要回传的事件。执行完成与回传送达分别记录。</p>}
      {deliveries.map(delivery => <div key={delivery.id} className="messaging-delivery">
        <div><strong>{delivery.target.kind === "origin" ? "原会话 · " : ""}{delivery.target.label}</strong><span data-status={delivery.status}>{DELIVERY_LABELS[delivery.status]}</span></div>
        <small>{delivery.event === "completed" ? "完成通知" : delivery.event === "failed" ? "失败通知" : "等待确认通知"} · 已尝试 {delivery.attempts} 次</small>
        {delivery.error && <p className="messaging-inline-error">{delivery.error}</p>}
        <details><summary>查看回传内容与回执</summary><pre>{delivery.text}</pre><pre>{delivery.receipt || "尚无送达回执"}</pre></details>
        {["failed", "blocked"].includes(delivery.status) && <button type="button" disabled={busy || delivery.attempts >= 5} onClick={() => onRetry(delivery.id)}>重试回传</button>}
      </div>)}
    </section>
    <section>
      <div className="messaging-section-label">处理时间线</div>
      <ol className="messaging-timeline">{message.timeline.map((item, index) => <li key={index}><time>{timeLabel(item.at)}</time><p>{item.text}</p></li>)}</ol>
    </section>
    <section><details className="messaging-raw"><summary>监听原始数据</summary><pre>{JSON.stringify(message.source.raw, null, 2)}</pre></details></section>
  </article>;
}
