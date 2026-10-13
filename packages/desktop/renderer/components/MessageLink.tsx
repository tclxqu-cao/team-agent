import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import { copyTextToClipboard } from "../lib/clipboard";

/** Keep navigation native; a held link offers its original address for copying. */
export default function MessageLink({ href, children, code = false }: { href: string; children: ReactNode; code?: boolean }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const backdropPressed = useRef(false);
  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  const show = () => { held.current = true; setCopied(false); setError(false); setOpen(true); };
  const dismiss = () => { held.current = false; setOpen(false); anchor.current?.focus({ preventScroll: true }); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); held.current = false; setOpen(false); anchor.current?.focus({ preventScroll: true }); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open]);

  return <>
    <a ref={anchor} className={`chat-message-link${code ? " chat-message-link--code" : ""}`} href={href} target="_blank" rel="noopener noreferrer" title="长按复制地址"
      onPointerDown={(event) => {
        cancelHold(); held.current = false;
        if (!event.isPrimary || event.button !== 0 || event.pointerType === "mouse") return;
        start.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(show, 550);
      }}
      onPointerMove={(event) => {
        if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10) cancelHold();
      }}
      onPointerUp={(event) => { cancelHold(); if (held.current) event.preventDefault(); }}
      onPointerCancel={cancelHold}
      onContextMenu={(event) => { event.preventDefault(); cancelHold(); show(); }}
      onClick={(event) => { if (held.current) { event.preventDefault(); held.current = false; } }}
    >{children}</a>
    {open && typeof document !== "undefined" && createPortal(
      <div className="message-link-actions-backdrop" data-tab-swipe-ignore
        onPointerDown={(event) => { backdropPressed.current = event.target === event.currentTarget; }}
        onClick={(event) => { if (backdropPressed.current && event.target === event.currentTarget) dismiss(); }}>
        <section className="message-link-actions" role="dialog" aria-modal="true" aria-label="链接操作">
          <div className="message-link-actions-heading"><strong>链接地址</strong><button type="button" className="ui-icon-button" aria-label="关闭链接操作" onClick={dismiss}><X size={16} /></button></div>
          <input aria-label="原始链接地址" value={href} readOnly onFocus={(event) => event.target.select()} />
          <button type="button" className="message-link-copy-button" autoFocus onClick={() => {
            void copyTextToClipboard(href).then((success) => { setCopied(success); setError(!success); });
          }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制地址" : "复制地址"}</button>
          <span role="status">{error ? "请长按上方地址，使用系统菜单复制" : copied ? "可在远程桌面点击“粘贴”" : ""}</span>
        </section>
      </div>, document.body,
    )}
  </>;
}
