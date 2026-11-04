import { useEffect, useRef } from "react";
import type { AgentType } from "../../../../core/src/domain/agent/agent-type";
import type { MessageEvent, MessagingSettings, RoutingCandidate } from "../../../../core/src/domain/messaging/types";

interface Props {
  value: MessagingSettings;
  candidates: RoutingCandidate[];
  sources: Array<{ database: string; accountId: string }>;
  busy: boolean;
  onChange: (value: MessagingSettings) => void;
  onDiscover: () => void;
  onSave: () => void;
  onClose: () => void;
}
export default function MessageSettings({ value, candidates, sources, busy, onChange, onDiscover, onSave, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  const updateRule = (index: number, patch: Partial<MessagingSettings["rules"][number]>) =>
    onChange({ ...value, rules: value.rules.map((rule, i) => i === index ? { ...rule, ...patch } : rule) });
  const updateSubscription = (index: number, patch: Partial<MessagingSettings["subscriptions"][number]>) =>
    onChange({ ...value, subscriptions: value.subscriptions.map((item, i) => i === index ? { ...item, ...patch } : item) });
  return <dialog ref={dialog} className="messaging-settings" aria-label="消息接入设置"
    onCancel={event => { event.preventDefault(); onClose(); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}>
    <header><h2>接入设置</h2><button type="button" aria-label="关闭接入设置" onClick={onClose}>关闭</button></header>
    <div className="messaging-settings-body">
    <label>路由方式<select value={value.routingMode} onChange={event => onChange({ ...value, routingMode: event.target.value as "model" | "rules" })}>
      <option value="model">模型判断（默认）</option><option value="rules">规则判断</option>
    </select></label>
    <p className="messaging-muted">{value.routingMode === "model" ? "根据消息内容选择已登记的项目和可用 Agent，无需逐群设置。判断不明确时由你确认。" : "每个群固定交给一个项目和 Agent。"}</p>
    {value.routingMode === "rules" && <div className="messaging-rule-list">
      {value.rules.map((rule, index) => <div key={index} className="messaging-rule">
        <input aria-label={"群会话 ID " + (index + 1)} placeholder="群会话 ID（消息详情中可查看）" value={rule.conversationId} onChange={event => updateRule(index, { conversationId: event.target.value })}/>
        <select aria-label={"规则项目 " + (index + 1)} value={rule.projectId} onChange={event => updateRule(index, { projectId: event.target.value, agentType: candidates.find(item => item.projectId === event.target.value)?.agents[0] ?? "codex" })}>
          <option value="">选择项目</option>{candidates.map(item => <option key={item.projectId} value={item.projectId}>{item.projectName}</option>)}
        </select>
        <select aria-label={"规则 Agent " + (index + 1)} value={rule.agentType} onChange={event => updateRule(index, { agentType: event.target.value as AgentType })}>
          {(candidates.find(item => item.projectId === rule.projectId)?.agents ?? []).map(agent => <option key={agent} value={agent}>{agent}</option>)}
        </select>
        <button type="button" onClick={() => onChange({ ...value, rules: value.rules.filter((_, i) => i !== index) })}>移除</button>
      </div>)}
      <button type="button" onClick={() => onChange({ ...value, rules: [...value.rules, { conversationId: "", projectId: candidates[0]?.projectId ?? "", agentType: candidates[0]?.agents[0] ?? "codex" }] })}>添加群规则</button>
    </div>}
    <div className="messaging-settings-section">
      <h3>企业微信</h3>
      <p>监听正文直接 @我的新消息，自动保存原始数据。</p>
      <button type="button" disabled={busy} onClick={onDiscover}>发现本机账号</button>
      {!!sources.length && <select aria-label="企微账号" value={JSON.stringify(value.source)} onChange={event => onChange({ ...value, source: event.target.value ? JSON.parse(event.target.value) : { database: "", accountId: "" } })}>
        <option value="">选择账号</option>{sources.map(source => <option key={source.database} value={JSON.stringify(source)}>账号 {source.accountId}</option>)}
      </select>}
      <p className="messaging-muted">{value.source.accountId ? "已选择账号 " + value.source.accountId : "开启时自动发现；多个账号时在这里选择。"}</p>
      <details><summary>数据来源</summary><p className="messaging-mono">{value.source.database || "尚未发现本机数据库"}</p></details>
    </div>
    <div className="messaging-settings-section">
      <h3>结果返回</h3><p>默认回到原渠道原会话，包含完成、失败和等待确认。</p>
      {value.subscriptions.map((subscription, index) => <div key={subscription.id} className="messaging-subscription">
        <div>
          <select aria-label={"接收方式 " + (index + 1)} value={subscription.kind} onChange={event => updateSubscription(index, { kind: event.target.value as "webhook" | "wecom" })}><option value="webhook">通知地址</option><option value="wecom">企微群</option></select>
          <input aria-label={"额外接收位置 " + (index + 1)} placeholder={subscription.kind === "webhook" ? "https://…" : "官方企微群 ID"} value={subscription.address} onChange={event => updateSubscription(index, { address: event.target.value })}/>
          <button type="button" onClick={() => onChange({ ...value, subscriptions: value.subscriptions.filter((_, i) => i !== index) })}>移除</button>
        </div>
        <div className="messaging-event-options">{(["completed", "failed", "waiting"] as const).map(event => <label key={event}>
          <input type="checkbox" checked={subscription.events.includes(event)} onChange={e => updateSubscription(index, { events: e.target.checked ? [...subscription.events, event] : subscription.events.filter(item => item !== event) })}/>
          {{ completed: "完成", failed: "失败", waiting: "等待确认" }[event]}
        </label>)}</div>
      </div>)}
      <button type="button" onClick={() => onChange({ ...value, subscriptions: [...value.subscriptions, { id: crypto.randomUUID(), enabled: true, events: ["completed", "failed", "waiting"] as MessageEvent[], kind: "webhook", address: "", label: "" }] })}>添加额外订阅</button>
    </div>
    </div>
    <footer><button type="button" className="messaging-primary" disabled={busy} onClick={onSave}>保存设置</button></footer>
  </dialog>;
}
