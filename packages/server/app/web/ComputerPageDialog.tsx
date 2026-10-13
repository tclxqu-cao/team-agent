"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { defaultPageOpenMode, normalizePageUrl } from "../../public/pwa/computer-directory.js";

export type ComputerPage = { id: string; name: string; url: string; openMode: "current" | "new-tab" };

export default function ComputerPageDialog({ computerName, page, onClose, onSave }: {
  computerName: string; page?: ComputerPage; onClose(): void; onSave(page: ComputerPage): Promise<void>;
}) {
  const [name, setName] = useState(page?.name ?? "");
  const [url, setUrl] = useState(page?.url ?? "");
  const [mode, setMode] = useState<ComputerPage["openMode"]>(page?.openMode ?? "current");
  const [modeChosen, setModeChosen] = useState(Boolean(page));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLInputElement>("input")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending.current) onClose();
      if (event.key !== "Tab") return;
      const controls = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled)');
      if (!controls?.length) return;
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return <div className="computer-dialog-backdrop" data-toolbar-overlay onClick={event => { if (event.target === event.currentTarget && !pending.current) onClose(); }}>
    <section ref={panel} className="computer-dialog" role="dialog" aria-modal="true" aria-labelledby="computer-page-title">
      <div className="computer-dialog-heading"><h2 id="computer-page-title">{page ? "编辑页面" : "添加页面"}</h2><button type="button" className="computer-close" aria-label="关闭" disabled={saving} onClick={onClose}><X size={20} /></button></div>
      <p className="computer-hint">所属电脑：{computerName}</p>
      <form onSubmit={async event => {
        event.preventDefault();
        if (pending.current) return;
        pending.current = true; setSaving(true); setError("");
        try {
          const normalized = normalizePageUrl(url);
          const id = page?.id ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
          await onSave({ id, name: name.trim(), url: normalized, openMode: mode });
        } catch (cause) { setError((cause as Error).message); }
        finally { pending.current = false; setSaving(false); }
      }}>
        <label htmlFor="computer-page-name">页面名称</label>
        <input id="computer-page-name" maxLength={60} required disabled={saving} value={name} onChange={event => setName(event.target.value)} placeholder="例如：Zcode / Qoder" autoComplete="off" />
        <label htmlFor="computer-page-url">页面地址</label>
        <input id="computer-page-url" required disabled={saving} value={url} onChange={event => { setUrl(event.target.value); if (!modeChosen) setMode(defaultPageOpenMode(event.target.value)); }} placeholder="https://…" autoComplete="off" spellCheck={false} />
        <label htmlFor="computer-page-mode">打开方式</label>
        <select id="computer-page-mode" disabled={saving} value={mode} onChange={event => { setMode(event.target.value as ComputerPage["openMode"]); setModeChosen(true); }}>
          <option value="current">当前页面打开，保留顶部图标栏</option>
          <option value="new-tab">新页面打开，保留原会话页</option>
        </select>
        <p className="computer-hint">当前页面会显示网站自己的界面。若网站禁止内嵌（如 Qoder），可改为新页面打开。</p>
        {error && <p className="computer-error" role="alert">{error}</p>}
        <button type="submit" className="computer-action computer-primary" disabled={saving || !name.trim() || !url.trim()}>{saving ? "正在保存…" : "保存页面"}</button>
      </form>
    </section>
  </div>;
}
