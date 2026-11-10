import { forwardRef, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ComposerModelPickerHandle {
  focus(options?: FocusOptions): void;
  showPicker(): void;
}

interface ModelOption { value: string; label: string; group?: string }
interface Props {
  value: string;
  options: ModelOption[];
  disabled?: boolean;
  onChange(value: string): void;
}

/** Keep model choices anchored inside this document, including mobile iframes. */
const ComposerModelPicker = forwardRef<ComposerModelPickerHandle, Props>(function ComposerModelPicker({ value, options, disabled, onChange }, ref) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: -1000, left: 0, width: 280, maxHeight: 360 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find(option => option.value === value);
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  useImperativeHandle(ref, () => ({
    focus: options => trigger.current?.focus(options),
    showPicker: () => { if (!disabled) setOpen(true); },
  }), [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const reposition = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const bottomEdge = topEdge + (viewport?.height ?? innerHeight) - 16;
      const rightEdge = leftEdge + (viewport?.width ?? innerWidth) - 16;
      const above = rect.top - topEdge - 6;
      const below = bottomEdge - rect.bottom - 6;
      const upwards = above >= Math.min(320, below);
      const maxHeight = Math.max(0, Math.min(360, upwards ? above : below));
      const height = Math.min(menu.current?.scrollHeight ?? 360, maxHeight);
      const width = Math.min(Math.max(rect.width, 280), rightEdge - leftEdge);
      setPosition({
        top: upwards ? Math.max(topEdge, rect.top - height - 6) : rect.bottom + 6,
        left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)), width, maxHeight,
      });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (trigger.current) observer.observe(trigger.current);
    if (menu.current) observer.observe(menu.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    viewport?.addEventListener("resize", reposition);
    viewport?.addEventListener("scroll", reposition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      viewport?.removeEventListener("resize", reposition);
      viewport?.removeEventListener("scroll", reposition);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const option = menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')
      ?? menu.current?.querySelector<HTMLButtonElement>('[role="option"]');
    option?.focus({ preventScroll: true });
    option?.scrollIntoView({ block: "nearest" });
    const dismiss = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);

  useEffect(() => { setOpen(false); }, [disabled]);

  return <>
    <button ref={trigger} type="button" className="web-native-model-picker-trigger" aria-label="当前模型" title={selected?.label ?? "切换模型"}
      aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? menuId : undefined} disabled={disabled}
      onClick={() => setOpen(current => !current)} onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>{selected?.label ?? "默认模型"}</button>
    {open && createPortal(<div ref={menu} id={menuId} className="composer-model-menu" role="listbox" aria-label="选择模型" style={position}
      onKeyDown={event => {
        if (event.key === "Tab") { setOpen(false); return; }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
      {options.map((option, index) => <div key={option.value}>
        {option.group && option.group !== options[index - 1]?.group && <div className="composer-model-group">{option.group}</div>}
        <button type="button" role="option" aria-selected={option.value === value} tabIndex={-1} title={option.label}
          onClick={() => { onChange(option.value); close(); }}>
          <span className="composer-model-check" aria-hidden="true">{option.value === value ? "✓" : ""}</span><span>{option.label}</span>
        </button>
      </div>)}
    </div>, document.body)}
  </>;
});

export default ComposerModelPicker;
