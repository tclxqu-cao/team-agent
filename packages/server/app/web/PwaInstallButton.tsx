"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Smartphone, Plus } from "lucide-react";

const primary: CSSProperties = {
  background: "color-mix(in srgb, var(--ui-tab-accent) 88%, var(--ui-text))",
  borderColor: "color-mix(in srgb, var(--ui-tab-accent) 88%, var(--ui-text))",
  color: "var(--ui-primary-text)",
};

export default function PwaInstallButton() {
  const [available, setAvailable] = useState(false);
  const [guide, setGuide] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const state = (event: Event) => setAvailable(Boolean((event as CustomEvent).detail?.available));
    const showGuide = () => setGuide(true);
    window.addEventListener("agentroam:pwa-state", state);
    window.addEventListener("agentroam:pwa-guide", showGuide);
    window.dispatchEvent(new Event("agentroam:pwa-query"));
    return () => { window.removeEventListener("agentroam:pwa-state", state); window.removeEventListener("agentroam:pwa-guide", showGuide); };
  }, []);
  useEffect(() => { if (guide && !dialog.current?.open) dialog.current?.showModal(); }, [guide]);
  return <>
    {available && <button type="button" className="file-drawer-toggle pwa-install-button" style={primary}
      title="添加到主屏幕" aria-label="添加到主屏幕"
      onClick={() => window.dispatchEvent(new Event("agentroam:pwa-install"))}>
      <span style={{ position: "relative", display: "flex" }}><Smartphone size={17} aria-hidden="true" /><Plus size={9} strokeWidth={3} aria-hidden="true" style={{ position: "absolute", right: -4, bottom: -2 }} /></span>
    </button>}
    {guide && <dialog ref={dialog} onClose={() => setGuide(false)} aria-labelledby="pwa-install-title"
      style={{ maxWidth: 340, width: "calc(100% - 40px)", margin: "auto", padding: 24, borderRadius: 16,
        border: "1px solid var(--ui-tabbar-border)", background: "var(--ui-root-bg)", color: "var(--ui-text)", whiteSpace: "normal", font: "14px/1.8 system-ui" }}>
      <h2 id="pwa-install-title" style={{ margin: "0 0 12px", fontSize: 18 }}>添加到主屏幕</h2>
      <p>iPhone / iPad：在 Safari 点击分享按钮，选择“添加到主屏幕”，再点“添加”。</p>
      <p>Android：打开浏览器菜单，选择“安装应用”或“添加到主屏幕”。</p>
      <p style={{ color: "var(--ui-muted-text)" }}>浏览器需要你确认，网页无法自动添加。从主屏幕打开后，如提示未配对，请重新扫码。</p>
      <button type="button" style={{ ...primary, width: "100%", padding: "10px 14px", borderStyle: "solid", borderWidth: 1, borderRadius: 8, cursor: "pointer" }} onClick={() => dialog.current?.close()}>知道了</button>
    </dialog>}
  </>;
}
