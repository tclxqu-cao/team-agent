import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

export default function HeaderActionMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const panelId = useId();

  useEffect(() => { setPortal(document.body); }, []);
  useLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor) return;
      const width = panel.current?.offsetWidth ?? 248;
      const height = panel.current?.offsetHeight ?? 0;
      setPosition({
        top: Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      });
    };
    reposition();
    const observer = new ResizeObserver(reposition);
    if (panel.current) observer.observe(panel.current);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, portal]);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", keydown);
    };
  }, [open]);

  // Keep controls mounted: pairing and other actions own portalled dialogs.
  const content = <div ref={panel} id={panelId} className="header-action-menu-panel" role="dialog" aria-label="更多功能" hidden={!open} style={{ position: "fixed", ...position }}>
    {children}
  </div>;
  return <>
    <button ref={trigger} type="button" className="ui-icon-button header-action-menu-trigger" title="更多功能" aria-label="更多功能" aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(value => !value)}
      onKeyDown={event => {
        if (event.key !== "ArrowDown") return;
        event.preventDefault();
        setOpen(true);
        requestAnimationFrame(() => Array.from(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []).find(button => button.getClientRects().length > 0)?.focus());
      }}>
      <MoreHorizontal size={20} aria-hidden="true" />
    </button>
    {portal ? createPortal(content, portal) : content}
  </>;
}
