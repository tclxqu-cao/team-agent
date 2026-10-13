"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Smartphone, Plus } from "lucide-react";

const primary: CSSProperties = {
  background: "color-mix(in srgb, var(--ui-tab-accent) 88%, var(--ui-text))",
  borderColor: "color-mix(in srgb, var(--ui-tab-accent) 88%, var(--ui-text))",
  color: "var(--ui-primary-text)",
};

export default function PwaInstallButton() {
  const [installed, setInstalled] = useState(false);
  const [guide, setGuide] = useState(false);
  const [portalNode, setPortalNode] = useState<HTMLElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    setPortalNode(document.querySelector<HTMLElement>(".web-root") ?? document.body);
    const state = (event: Event) => setInstalled(Boolean((event as CustomEvent).detail?.installed));
    const showGuide = () => setGuide(true);
    window.addEventListener("agentroam:pwa-state", state);
    window.addEventListener("agentroam:pwa-guide", showGuide);
    window.dispatchEvent(new Event("agentroam:pwa-query"));
    return () => { window.removeEventListener("agentroam:pwa-state", state); window.removeEventListener("agentroam:pwa-guide", showGuide); };
  }, []);
  useEffect(() => { if (guide && !dialog.current?.open) dialog.current?.showModal(); }, [guide]);
  return <>
    <button type="button" className="file-drawer-toggle pwa-install-button"
      title={installed ? "已添加到主屏幕" : "添加到主屏幕"} aria-label={installed ? "已添加到主屏幕" : "添加到主屏幕"}
      onClick={() => installed ? setGuide(true) : window.dispatchEvent(new Event("agentroam:pwa-install"))}>
      <span style={{ position: "relative", display: "flex" }}><Smartphone size={17} aria-hidden="true" /><Plus size={9} strokeWidth={3} aria-hidden="true" style={{ position: "absolute", right: -4, bottom: -2 }} /></span>
    </button>
    {guide && portalNode && createPortal(<dialog ref={dialog} data-toolbar-overlay onClose={() => setGuide(false)} aria-labelledby="pwa-install-title"
      style={{ maxWidth: 340, width: "calc(100% - 40px)", margin: "auto", padding: 24, borderRadius: 16,
        border: "1px solid var(--ui-tabbar-border)", background: "var(--ui-root-bg)", color: "var(--ui-text)", whiteSpace: "normal", font: "14px/1.8 system-ui" }}>
      <h2 id="pwa-install-title" style={{ margin: "0 0 12px", fontSize: 18 }}>{installed ? "已添加到主屏幕" : "添加到主屏幕"}</h2>
      {installed && <p>当前已在主屏幕应用中打开。</p>}
      <p>iPhone / iPad：在 Safari 点击分享按钮，选择“添加到主屏幕”，再点“添加”。</p>
      <p>Android：打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。</p>
      <p style={{ color: "var(--ui-muted-text)" }}>浏览器需要你确认，网页无法自动添加。从主屏幕打开后，如提示未配对，请重新扫码。</p>
      <button type="button" style={{ ...primary, width: "100%", padding: "10px 14px", borderStyle: "solid", borderWidth: 1, borderRadius: 8, cursor: "pointer" }} onClick={() => dialog.current?.close()}>知道了</button>
    </dialog>, portalNode)}
  </>;
}
