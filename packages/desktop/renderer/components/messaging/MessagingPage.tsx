import { useCallback, useEffect, useState } from "react";
import { Inbox, Search, Settings2, Play, Pause, RefreshCw, X } from "lucide-react";
import type { DeliveryRecord, MessageRecord, MessagingList, MessagingSettings, RoutingCandidate } from "../../../../core/src/domain/messaging/types";
import { messagingRequest, DELIVERY_LABELS, EXECUTION_LABELS, timeLabel } from "./client";
import MessageDetail from "./MessageDetail";
import MessageSettings from "./MessageSettings";
import { useUIStore } from "../../stores/uiStore";
import "./messaging.css";
import { MESSAGING_READY } from "../../../../core/src/domain/web-console/MessagingBridge";
import ActionErrorDialog from "../ActionErrorDialog";
import { useErrorNotice } from "../../lib/use-error-notice";

type MessageRow = MessagingList["messages"][number];
export function MessageTable({ messages, selected, onSelect }: { messages: MessageRow[]; selected: string | null; onSelect: (id: string) => void }) {
  return <table className="messaging-table"><thead><tr><th>收到时间 / 来源</th><th>消息</th><th>判断方式</th><th>路由目标</th><th>会话执行</th><th>结果回传</th></tr></thead>
    <tbody>{messages.map(message => <tr key={message.id} className={selected === message.id ? "is-selected" : ""}>
      <td><time>{timeLabel(message.receivedAt)}</time><strong>{message.source.conversationName || message.source.conversationId}</strong></td>
      <td><button type="button" className="messaging-message-button" onClick={() => onSelect(message.id)}><span>{message.source.text || "非文本消息"}</span><small>{message.routing.decision?.reason || "等待判断"}</small></button></td>
      <td><span className="messaging-method">{message.routing.confirmedByUser ? "用户确认" : message.routing.mode === "model" ? "模型" : "规则"}</span></td>
      <td><strong>{message.execution.projectName || message.routing.decision?.projectId || "—"}</strong><small>{message.routing.decision?.agentType}</small></td>
      <td><span className="messaging-status" data-status={message.routing.status === "review" ? "review" : message.execution.status}>{message.routing.status === "ignored" ? "未触发" : message.routing.status === "review" ? "待确认路由" : message.routing.status === "routing" ? "正在判断" : message.routing.status === "pending" ? "等待判断" : EXECUTION_LABELS[message.execution.status]}</span></td>
      <td><span className="messaging-status" data-status={message.deliveryStatus}>{DELIVERY_LABELS[message.deliveryStatus]}</span></td>
    </tr>)}</tbody>
  </table>;
}
export default function MessagingPage({ onClose, onOpenSession }: { onClose?: () => void; onOpenSession?: (message: MessageRecord) => void }) {
  const skin = useUIStore(state => state.skin);
  useEffect(() => { document.documentElement.setAttribute("data-skin", skin); }, [skin]);
  const [snapshot, setSnapshot] = useState<MessagingList | null>(null);
  const [selected, setSelected] = useState<string | null>(() => typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("message"));
  const [detail, setDetail] = useState<{ message: MessageRecord; deliveries: DeliveryRecord[] } | null>(null);
  const [settings, setSettings] = useState<MessagingSettings | null>(null);
  const [candidates, setCandidates] = useState<RoutingCandidate[]>([]);
  const [sources, setSources] = useState<Array<{ database: string; accountId: string }>>([]);
  const [query, setQuery] = useState(""); const [filter, setFilter] = useState("mentioned");
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const [settingsOpen, setSettingsOpen] = useState(false); const [busy, setBusy] = useState(false);
  const { notice, report, recover, dismiss } = useErrorNotice();
  const [revision, setRevision] = useState(0);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const refresh = useCallback(() => {
    for (const source of ["list", "detail", "worker"]) recover(source);
    setRevision(value => value + 1);
  }, [recover]);
  const cursor = cursors.at(-1);
  useEffect(() => {
    if (window.parent !== window) window.parent.postMessage({ type: MESSAGING_READY }, window.location.origin);
  }, []);
  useEffect(() => {
    let disposed = false;
    void messagingRequest<{ settings: MessagingSettings; candidates: RoutingCandidate[] }>({ action: "settings" }).then(value => {
      if (!disposed) { setSettings(value.settings); setCandidates(value.candidates); recover("settings"); }
    }).catch(error => {
      if (!disposed) report({ source: "settings", title: "接入设置加载失败", message: error instanceof Error ? error.message : "无法加载接入设置", onRetry: () => setSettingsRevision(value => value + 1) }, settingsRevision > 0);
    });
    return () => { disposed = true; };
  }, [settingsRevision, report, recover]);
  useEffect(() => {
    let disposed = false; let running = false;
    const poll = async () => {
      if (running) return; running = true;
      try {
        const value = await messagingRequest<MessagingList>({ action: "list", query, filter, before: cursor });
        if (!disposed) {
          setSnapshot(value); recover("list");
          if (value.worker.state === "error" && value.worker.error) report({ source: "worker", title: "消息接入异常", message: value.worker.error, onRetry: refresh });
          else recover("worker");
        }
      } catch (error) {
        if (!disposed) report({ source: "list", title: "消息列表加载失败", message: error instanceof Error ? error.message : "无法加载消息列表", onRetry: refresh });
      }
      finally { running = false; }
    };
    const start = setTimeout(() => void poll(), 180);
    const timer = setInterval(() => void poll(), 5000);
    return () => { disposed = true; clearTimeout(start); clearInterval(timer); };
  }, [query, filter, cursor, revision, report, recover, refresh]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    let disposed = false; let running = false;
    const poll = async () => {
      if (running) return; running = true;
      try { const value = await messagingRequest<{ message: MessageRecord; deliveries: DeliveryRecord[] }>({ action: "detail", id: selected }); if (!disposed) { setDetail(value); recover("detail"); } }
      catch (error) { if (!disposed) report({ source: "detail", title: "消息详情加载失败", message: error instanceof Error ? error.message : "无法加载消息详情", onRetry: refresh }); }
      finally { running = false; }
    };
    setDetail(null); void poll(); const timer = setInterval(() => void poll(), 5000);
    return () => { disposed = true; clearInterval(timer); };
  }, [selected, revision, report, recover, refresh]);
  const perform = async (action: () => Promise<void>, title = "操作失败") => {
    setBusy(true); recover("action");
    try { await action(); setRevision(value => value + 1); }
    catch (error) { report({ source: "action", title, message: error instanceof Error ? error.message : "操作失败" }, true); }
    finally { setBusy(false); }
  };
  const save = async (value: MessagingSettings) => { setSettings(await messagingRequest<MessagingSettings>({ action: "saveSettings", settings: value })); };
  const state = snapshot?.worker.state ?? "paused";
  return <div className={"messaging-page" + (selected ? " has-detail" : "")}>
    <header className="messaging-heading">
      <div><div className="messaging-eyebrow"><Inbox size={15}/>多渠道消息</div><h1>消息接入 <span className="messaging-worker" data-status={state}><i/>{({ paused: "已暂停", starting: "正在连接", listening: "监听中", error: "接入异常" })[state]}</span></h1><p>从收到消息到执行、回传，每一步都可以核对。</p></div>
      <div className="messaging-toolbar">
        <button type="button" aria-label="刷新消息" onClick={refresh}><RefreshCw size={15}/></button>
        <button type="button" onClick={() => { if (!settings) setSettingsRevision(value => value + 1); setSettingsOpen(value => !value); }}><Settings2 size={15}/>接入设置</button>
        <button type="button" className="messaging-primary" disabled={!settings || busy} onClick={() => settings && void perform(() => save({ ...settings, enabled: !settings.enabled }), "监听设置失败")}>{settings?.enabled ? <Pause size={15}/> : <Play size={15}/>} {settings?.enabled ? "暂停监听" : "开始监听"}</button>
        {onClose && <button type="button" aria-label="关闭消息接入" onClick={onClose}><X size={16}/></button>}
      </div>
    </header>
    <div className="messaging-summary">
      <span>已接收 <strong>{snapshot?.counts.total ?? 0}</strong></span><span>待确认 <strong>{snapshot?.counts.review ?? 0}</strong></span>
      <span>执行中 <strong>{snapshot?.counts.running ?? 0}</strong></span><span>已完成 <strong>{snapshot?.counts.completed ?? 0}</strong></span>
      <span data-status={snapshot?.counts.deliveryFailed ? "failed" : undefined}>回传待处理 <strong>{snapshot?.counts.deliveryFailed ?? 0}</strong></span>
    </div>
    {settingsOpen && settings && <MessageSettings value={settings} candidates={candidates} sources={sources} busy={busy} onChange={setSettings} onClose={() => setSettingsOpen(false)}
      onSave={() => void perform(async () => { await save(settings); setSettingsOpen(false); }, "保存接入设置失败")}
      onDiscover={() => void perform(async () => {
        const result = await messagingRequest<{ sources: typeof sources; error?: string }>({ action: "discover" }); setSources(result.sources);
        if (result.error) throw new Error(result.error);
        if (result.sources.length === 1) setSettings({ ...settings, source: result.sources[0] });
      }, "发现账号失败")}/>}
    <div className="messaging-workspace">
      <div className="messaging-inbox">
        <div className="messaging-filters">
          <label className="messaging-search"><Search size={15}/><input type="search" aria-label="搜索监听消息" placeholder="搜索群名或消息内容" value={query} onChange={event => { setQuery(event.target.value); setCursors([undefined]); }}/></label>
          <select aria-label="消息筛选" value={filter} onChange={event => { setFilter(event.target.value); setCursors([undefined]); }}>
            <option value="mentioned">直接 @我</option><option value="all">全部监听消息</option><option value="review">待确认路由</option><option value="running">执行中 / 待核对</option><option value="completed">执行完成</option><option value="deliveryFailed">回传待处理</option>
          </select>
        </div>
        <div className="messaging-table-scroll">{snapshot?.messages.length ? <MessageTable messages={snapshot.messages} selected={selected} onSelect={setSelected}/>
          : <div className="messaging-empty"><Inbox size={34}/><h2>{snapshot ? "还没有符合条件的消息" : "正在加载消息…"}</h2><p>{snapshot ? "开启监听后，新的正文直接 @我消息会出现在这里。也可以切换到“全部监听消息”查看接收原文。" : "正在读取已保存的消息记录。"}</p></div>}</div>
        <footer className="messaging-pagination"><span>第 {cursors.length} 页 · 每页最多 50 条</span><button type="button" disabled={cursors.length === 1} onClick={() => setCursors(value => value.slice(0, -1))}>上一页</button><button type="button" disabled={!snapshot?.nextCursor} onClick={() => snapshot?.nextCursor && setCursors(value => [...value, snapshot.nextCursor!])}>下一页</button></footer>
      </div>
      {selected && (detail ? <MessageDetail key={selected} {...detail} candidates={candidates} busy={busy} onBack={() => setSelected(null)} onOpenSession={onOpenSession}
        onResolve={(projectId, agentType) => void perform(async () => { await messagingRequest({ action: "resolve", id: selected, projectId, agentType }); }, "消息路由失败")}
        onRetry={id => void perform(async () => { await messagingRequest({ action: "retryDelivery", id }); }, "结果回传失败")}/>
        : <div className="messaging-detail messaging-muted"><button type="button" onClick={() => setSelected(null)}>返回列表</button><p>正在加载原始消息与处理记录…</p></div>)}
    </div>
    {notice && <ActionErrorDialog {...notice} onClose={dismiss}/>}
  </div>;
}
