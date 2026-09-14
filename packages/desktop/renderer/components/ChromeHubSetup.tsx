import { useEffect, useState } from "react";

export default function ChromeHubSetup({ onClose }: { onClose: () => void }) {
  const api = window.agentApi;
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [extensionPath, setExtensionPath] = useState("");
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let active = true;
    void api.hubChromeStatus().then((status) => { if (active) setConnected(status.connected && status.compatible !== false); }).catch(() => { if (active) setMessage("暂时无法检测插件连接，请稍后重试"); });
    const unsubscribe = api.onHubChromeEvent((event) => { if (event.type === "chrome-status") setConnected(event.status.connected && event.status.compatible !== false); });
    return () => { active = false; unsubscribe(); };
  }, [api]);
  const install = async () => {
    setPending(true);
    setMessage("");
    try {
      const result = await api.hubChromeInstallExtension();
      setExtensionPath(result.path);
      setMessage(result.browserOpened ? "已打开 Chrome 扩展管理页，插件目录路径已复制。" : "未能打开 Chrome。请先安装或打开 Google Chrome，再进入 chrome://extensions；插件目录路径已复制。");
    } catch { setMessage("未能准备插件，请确认桌面端已启动，稍后重试。"); }
    finally { setPending(false); }
  };
  return <div data-aihub-chrome-setup="" style={{ flexShrink: 0, padding: "12px 18px", background: "var(--bg-elevated)", borderBottom: "1px solid var(--border-subtle)", fontSize: 12 }}>
    <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}><strong>连接日常 Google Chrome</strong><span role="status">{connected ? "扩展已连接" : "等待扩展连接"}</span><button className="ui-icon-button ui-icon-button--auto" style={{ marginLeft: "auto" }} onClick={onClose}>收起</button></div>
    <p style={{ margin: "0 0 8px", lineHeight: 1.7 }}>插件已随桌面端附带，无需另行下载。首次加载需要在 Chrome 中确认；加载后自动连接，连接成功后此引导会自动收起。已安装时刷新 AI Hub 扩展即可更新。</p>
    <ol style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
      <li>点击「安装浏览器插件」，在打开的 Chrome 扩展管理页开启「开发者模式」。</li>
      <li>选择「加载已解压的扩展程序」，选中 ai-hub-chrome-extension 文件夹。macOS 文件选择窗口可按 ⌘⇧G，粘贴已复制的路径并打开。</li>
      <li>在同一个 Chrome 中完成网站登录，即可回到 AI Hub 查看回复并同步发送。取消 Chrome 顶部的调试提示会暂停连接；在 AI Hub 点击「恢复全部 Chrome 连接」即可继续。</li>
    </ol>
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
      <button type="button" disabled={pending} className="ui-icon-button ui-icon-button--auto" onClick={() => void install()} style={{ padding: "5px 10px" }}>{pending ? "正在打开…" : "安装浏览器插件"}</button>
      <button type="button" className="ui-icon-button ui-icon-button--auto" onClick={() => { void api.hubChromeRevealExtension().catch(() => setMessage("未能打开扩展目录")); }} style={{ padding: "5px 10px" }}>打开插件文件夹</button>
      {message && <span role="status">{message}</span>}
    </div>
    {extensionPath && <p style={{ margin: "8px 0 0", overflowWrap: "anywhere", userSelect: "text" }}>插件目录：{extensionPath}</p>}
  </div>;
}
