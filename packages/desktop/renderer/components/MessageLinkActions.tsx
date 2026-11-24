import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, X } from "lucide-react";
import { copyTextToClipboard } from "../../../shared/src/browser/clipboard";

export function useMessageLinkActions<T extends HTMLElement>() {
  const trigger = useRef<T>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);
  const [open, setOpen] = useState(false);

  const cancelHold = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  const show = () => setOpen(true);
  const close = () => {
    held.current = false;
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return {
    trigger, open, close, show,
    consumeClick(event: MouseEvent<T>) {
      if (!held.current) return false;
      held.current = false;
      event.preventDefault();
      return true;
    },
    handlers: {
      onPointerDown(event: PointerEvent<T>) {
        cancelHold();
        held.current = false;
        if (!event.isPrimary || event.button !== 0 || event.pointerType === "mouse") return;
        start.current = { x: event.clientX, y: event.clientY };
        timer.current = setTimeout(() => { held.current = true; show(); }, 550);
      },
      onPointerMove(event: PointerEvent<T>) {
        if (start.current && Math.hypot(event.clientX - start.current.x, event.clientY - start.current.y) > 10) cancelHold();
      },
      onPointerUp(event: PointerEvent<T>) {
        cancelHold();
        if (held.current) event.preventDefault();
      },
      onPointerCancel: cancelHold,
      onContextMenu(event: MouseEvent<T>, nativeMenu?: () => boolean) {
        event.preventDefault();
        cancelHold();
        if (!held.current) {
          held.current = true;
          if (nativeMenu?.()) return;
        }
        if (!open) show();
      },
    },
  };
}

interface CopyAction {
  label: string;
  value: string;
}

export function MessageLinkActions({ title, fieldLabel, primary, secondary, onClose }: {
  title: string;
  fieldLabel: string;
  primary: CopyAction;
  secondary?: CopyAction;
  onClose(): void;
}) {
  const [result, setResult] = useState<{ action: CopyAction; copied: boolean } | null>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const backdropPressed = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, []);

  useEffect(() => {
    if (result && !result.copied) {
      input.current?.focus();
      input.current?.select();
    }
  }, [result]);

  const copyButton = (action: CopyAction, autoFocus = false) => <button type="button"
    className="message-link-copy-button" autoFocus={autoFocus} onClick={async () => {
      const copied = await copyTextToClipboard(action.value);
      setResult({ action, copied });
    }}>
    {result?.copied && result.action.label === action.label ? <Check size={16} /> : <Copy size={16} />}
    {action.label}
  </button>;

  return createPortal(
    <div className="message-link-actions-backdrop" data-tab-swipe-ignore
      onPointerDown={(event) => { backdropPressed.current = event.target === event.currentTarget; }}
      onClick={(event) => { if (backdropPressed.current && event.target === event.currentTarget) onClose(); }}>
      <section className="message-link-actions" role="dialog" aria-modal="true" aria-label="链接操作">
        <div className="message-link-actions-heading">
          <strong>{title}</strong>
          <button type="button" className="ui-icon-button" aria-label="关闭链接操作" onClick={onClose}><X size={16} /></button>
        </div>
        <input ref={input} aria-label={fieldLabel} value={result && !result.copied ? result.action.value : primary.value}
          readOnly onFocus={(event) => event.target.select()} />
        {copyButton(primary, true)}
        {secondary && copyButton(secondary)}
        <span role="status">{result ? result.copied ? "已复制" : "请选中上方文字，使用系统菜单复制" : ""}</span>
      </section>
    </div>, document.body,
  );
}
