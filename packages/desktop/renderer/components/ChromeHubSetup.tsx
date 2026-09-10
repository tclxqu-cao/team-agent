import { useEffect, useState } from "react";

export default function ChromeHubSetup({ onClose }: { onClose: () => void }) {
  const api = window.agentApi;
  const [message, setMessage] = useState("");
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    void api.hubChromeStatus().then((status) => setConnected(status.connected));
    return api.onHubChromeEvent((event) => { if (event.type === "chrome-status") setConnected(event.status.connected); });
  }, [api]);
  return <div data-aihub-chrome-setup="" style={{ flexShrink: 0, padding: "12px 18px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-subtle)", fontSize: 12 }}>
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}><strong>连接日常 Google Chrome</strong><span role="status">{connected ? "扩展已连接" : "等待扩展连接"}</span><button className="ui-icon-button ui-icon-button--auto" style={{ marginLeft: "auto" }} onClick={onClose}>收起</button></div>
    <p style={{ margin: "0 0 8px", lineHeight: 1.7 }}>扩展支持自动连接，无需配对。已安装时，在 Chrome 扩展管理页刷新 AI Hub 扩展即可更新。</p>
    <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
      <li>首次使用：打开 Chrome 的 chrome://extensions，开启「开发者模式」，选择「加载已解压的扩展程序」，选中下面打开的 ai-hub-chrome-extension 文件夹。</li>
      <li>加载后会自动连接桌面端，并发现已打开的 ChatGPT、Gemini、Grok 标签页；无需逐页接入。</li>
      <li>在同一个 Chrome 中完成网站登录，即可回到 AI Hub 查看回复并同步发送。取消 Chrome 顶部的调试提示会暂停连接；在 AI Hub 点击「恢复全部 Chrome 连接」即可继续。</li>
    </ol>
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
      <button className="ui-icon-button ui-icon-button--auto" onClick={() => { void api.hubChromeRevealExtension().catch(() => setMessage("未能打开扩展目录")); }} style={{ padding: "5px 10px" }}>打开扩展文件夹</button>
      {message && <span role="status">{message}</span>}
    </div>
  </div>;
}
