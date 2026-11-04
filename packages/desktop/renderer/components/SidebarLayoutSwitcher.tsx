import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, PanelsTopLeft } from "lucide-react";
import { NAVIGATION_LAYOUT_LABELS, type NavigationLayout } from "../../../core/src/domain/web-console/navigation-layout";
import { useUIStore } from "../stores/uiStore";
import "../styles/sidebar-layout-switcher.css";

const OPTIONS: { value: NavigationLayout; description: string }[] = [
  { value: "classic", description: "横向切换 Agent，按目录浏览" },
  { value: "agent-rail", description: "竖向 Agent 栏，聚焦当前工作区" },
  { value: "all-sessions", description: "汇总所有 Agent 的会话" },
];

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function LayoutPreview({ value }: { value: NavigationLayout }) {
  return <svg className="sidebar-layout-preview" viewBox="0 0 48 36" fill="none" aria-hidden="true">
    <rect x="1" y="1" width="46" height="34" rx="5" stroke="currentColor" strokeOpacity=".3" />
    {value === "classic" ? <>
      <path d="M6 8h16M6 20h13M6 25h10M6 30h12" stroke="currentColor" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" />
      {[7, 13, 19, 25, 31, 37].map(x => <rect key={x} x={x} y="12" width="4" height="4" rx="1" fill="currentColor" opacity=".7" />)}
    </> : value === "agent-rail" ? <>
      <path d="M6 8h28M14 13v21" stroke="currentColor" strokeOpacity=".3" strokeWidth="2" strokeLinecap="round" />
      {[16, 22, 28].map(y => <rect key={y} x="6" y={y} width="4" height="4" rx="1" fill="currentColor" opacity=".7" />)}
      <path d="M20 17h18M20 23h12M20 29h15" stroke="currentColor" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" />
    </> : <>
      <path d="M6 8h22" stroke="currentColor" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" />
      {[16, 22, 28].map((y, index) => <g key={y}>
        <circle cx="7" cy={y} r="1.5" fill="currentColor" opacity=".7" />
        <path d={`M12 ${y}h${index === 1 ? 18 : 25}`} stroke="currentColor" strokeOpacity=".55" strokeWidth="2" strokeLinecap="round" />
      </g>)}
    </>}
  </svg>;
}

export default function SidebarLayoutSwitcher() {
  const value = useUIStore(state => state.navigationLayout);
  const onChange = useUIStore(state => state.setNavigationLayout);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useBrowserLayoutEffect(() => {
    if (!open) return;
    const reposition = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      if (!anchor || !panel.current) return;
      const { offsetWidth: width, offsetHeight: height } = panel.current;
      setPosition({
        top: Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - height - 8)),
        left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      });
    };
    reposition();
    panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!trigger.current?.contains(target) && !panel.current?.contains(target)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      trigger.current?.focus();
    }
    const buttons = Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown" ? (index + 1) % buttons.length
      : event.key === "ArrowUp" ? (index + buttons.length - 1) % buttons.length
      : event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    buttons[next]?.focus();
  };

  return <>
    <button ref={trigger} type="button" className="sidebar-layout-trigger" aria-label="切换侧栏布局"
      title={`切换布局 · 当前：${NAVIGATION_LAYOUT_LABELS[value]}`} aria-haspopup="menu" aria-expanded={open}
      aria-controls={open ? menuId : undefined} onClick={() => setOpen(current => !current)}
      onKeyDown={event => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
      }}>
      <PanelsTopLeft size={18} aria-hidden="true" />
    </button>
    {open && createPortal(<div ref={panel} id={menuId} role="menu" aria-label="侧栏布局"
      className="sidebar-layout-menu" style={{ position: "fixed", ...position }} onKeyDown={handleKeyDown}
      onBlur={event => {
        // A pointer press may blur the selected option before its click runs.
        // Outside pointer presses are already handled by the document listener.
        const next = event.relatedTarget;
        if (next && !event.currentTarget.contains(next) && !trigger.current?.contains(next)) setOpen(false);
      }}>
      <div className="sidebar-layout-menu-title" aria-hidden="true">侧栏布局</div>
      {OPTIONS.map(option => <button key={option.value} type="button" role="menuitemradio" aria-label={NAVIGATION_LAYOUT_LABELS[option.value]} aria-checked={value === option.value}
        className="sidebar-layout-option" onClick={() => {
          setOpen(false);
          onChange(option.value);
          requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".sidebar-layout-trigger")?.focus());
        }}>
        <LayoutPreview value={option.value} />
        <span className="sidebar-layout-option-copy"><span>{NAVIGATION_LAYOUT_LABELS[option.value]}</span><small>{option.description}</small></span>
        {value === option.value && <Check size={16} aria-hidden="true" />}
      </button>)}
    </div>, document.body)}
  </>;
}
