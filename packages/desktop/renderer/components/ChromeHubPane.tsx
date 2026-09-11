import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChromeHubConversation, ChromeHubStatus } from "../../main/ai-hub/chrome-bridge-protocol";
import { renderAssistantText } from "./ChatView";

export default function ChromeHubPane({ siteId, name, onSetup }: { siteId: string; name: string; onSetup: () => void }) {
  const api = window.agentApi;
  const [conversation, setConversation] = useState<ChromeHubConversation | null>(null);
  const [status, setStatus] = useState<ChromeHubStatus>({ connected: false, tabs: [] });
  const [error, setError] = useState("");
  const [resuming, setResuming] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [following, setFollowing] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const attached = !status.paused && status.compatible !== false && status.tabs.some((tab) => tab.siteId === siteId);

  useEffect(() => {
    let disposed = false;
    let statusReceived = false;
    let conversationReceived = false;
    void api.hubChromeStatus().then((value) => { if (!disposed && !statusReceived) setStatus(value); });
    if (typeof api.hubChromeConversation !== "function") setError("请重启 AI Hub 桌面端以启用消息面板");
    else void api.hubChromeConversation(siteId).then((value) => { if (!disposed && !conversationReceived) setConversation(value); });
    const unsubscribe = api.onHubChromeEvent((event) => {
      if (event.type === "chrome-conversation" && event.conversation.siteId === siteId) {
        conversationReceived = true;
        setConversation((previous) => !previous || event.conversation.revision > previous.revision ? event.conversation : previous);
        setError("");
      }
      if (event.type === "chrome-status") {
        statusReceived = true;
        setStatus(event.status);
        if (!event.status.tabs.some((tab) => tab.siteId === siteId)) { setConversation(null); setError(""); }
      }
      if (event.type === "chrome-page-error" && event.siteId === siteId) setError(event.error);
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; unsubscribe(); clearInterval(timer); };
  }, [api, siteId]);

  useLayoutEffect(() => {
    if (following && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [conversation?.revision, following]);

  const stale = attached && !!conversation && now - conversation.receivedAt > 6000;
  const description = status.paused ? "Chrome 网页连接已暂停，点击下方按钮即可恢复。"
    : status.connected && status.compatible === false ? "请从「连接 Chrome」加载新版自动连接扩展。"
    : !attached ? "在日常 Chrome 中打开并登录此站点，扩展会自动接入；若已暂停，请在扩展中恢复自动连接。"
    : !conversation ? "正在读取网页对话…"
    : conversation.generating ? "正在回复…"
    : !conversation.composerAvailable ? "未找到输入框，请在 Chrome 检查页面"
    : "已同步 · 从下方输入框发送消息";

  return <div data-aihub-native-pane={siteId} style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", minWidth: 0 }}>
    <div role="status" style={{ padding: "10px 16px", fontSize: 12, lineHeight: 1.6, color: "var(--text-secondary)", borderBottom: "1px solid var(--border-subtle)" }}>{description}</div>
    <div ref={scroller} onScroll={() => { const el = scroller.current; if (el) setFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 60); }}
      style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "18px 16px", overflowWrap: "anywhere" }}>
      {!attached ? <div style={{ display: "grid", gap: 14, paddingTop: 36, textAlign: "center", justifyItems: "center" }}>
        <strong style={{ fontSize: 18 }}>{status.paused ? `${name} 已暂停` : `连接 ${name}`}</strong>
        <span style={{ fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.7 }}>{status.paused ? "取消 Chrome 的调试提示也会暂停连接，无需重新登录。" : "登录态保留在 Chrome，回复会以文字显示在这里。"}</span>
        {status.paused && <button className="ui-icon-button ui-icon-button--auto" disabled={resuming} style={{ padding: "8px 12px", color: "var(--accent)" }} onClick={async () => {
          setResuming(true); setError("");
          try { setStatus(await api.hubChromeResume()); }
          catch (cause) { setError(cause instanceof Error ? cause.message : "恢复连接失败，请检查 Chrome 扩展"); }
          finally { setResuming(false); }
        }}>{resuming ? "正在恢复…" : "恢复全部 Chrome 连接"}</button>}
        <button className="ui-icon-button ui-icon-button--auto" style={{ padding: "8px 12px" }} onClick={() => { void api.hubOpenChrome(siteId).catch(() => setError("无法打开 Chrome，请检查是否已安装")); }}>登录 / 打开原网页</button>
        <button className="ui-icon-button ui-icon-button--auto" style={{ padding: "8px 12px" }} onClick={onSetup}>连接设置</button>
      </div> : !conversation?.messages.length ? <p style={{ margin: "32px 0", color: "var(--text-muted)", fontSize: 15, lineHeight: 1.8 }}>连接后会显示当前网页对话。可以在下方输入消息，也可以在 Chrome 中继续聊天。</p> : conversation.messages.map((message) => <article key={`${conversation.conversationId}:${message.id}`} data-message-id={message.id}
        style={{ marginBottom: 24, padding: message.role === "user" ? "12px 14px" : "0 2px", borderRadius: 12, background: message.role === "user" ? "var(--bg-deep)" : "transparent" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, fontSize: 12, color: "var(--text-muted)" }}>
          <strong>{message.role === "user" ? "你" : name}</strong>
          <button className="ui-icon-button ui-icon-button--auto" aria-label={`复制 ${message.role === "user" ? "消息" : name + " 回复"}`} style={{ padding: "2px 5px", fontSize: 11 }} onClick={() => { void navigator.clipboard.writeText(message.content).catch(() => setError("未能复制，请选择文字复制")); }}>复制</button>
        </div>
        <div style={{ fontSize: 15, lineHeight: 1.8, whiteSpace: "pre-wrap", color: "var(--text-primary)" }}>{renderAssistantText(message.content)}</div>
      </article>)}
    </div>
    {!following && <button className="ui-icon-button ui-icon-button--auto" style={{ alignSelf: "center", padding: "7px 12px", margin: 8 }} onClick={() => setFollowing(true)}>回到最新回复 ↓</button>}
    {(error || stale) && <div role={error ? "alert" : "status"} title={error || "暂未收到网页更新，请检查 Chrome 标签页或扩展连接；不代表 AI 已停止回答"} style={{ padding: "6px 16px", fontSize: 12, lineHeight: 1.6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: error ? "var(--danger)" : "var(--text-muted)" }}>{error || "同步暂未更新"}</div>}
  </div>;
}
