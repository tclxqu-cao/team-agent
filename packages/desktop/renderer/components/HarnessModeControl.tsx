import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { UnifiedSessionSummary } from "../global";

type Mode = NonNullable<UnifiedSessionSummary["nativeMode"]>;

export default function HarnessModeControl({ sessionId, mode }: { sessionId: string | null; mode?: Mode }) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(mode?.currentValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const activeSession = useRef(sessionId);
  activeSession.current = sessionId;
  useEffect(() => { setCurrent(mode?.currentValue); setOpen(false); setError(null); }, [sessionId, mode?.currentValue]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const select = async (value: string) => {
    if (!sessionId || !mode?.canChange || !window.agentApi?.setSessionNativeMode || inFlight.current) return;
    const target = sessionId;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const updated = await window.agentApi.setSessionNativeMode(target, value);
      if (activeSession.current === target) { setCurrent(updated.nativeMode?.currentValue); setOpen(false); }
    } catch (cause) {
      if (activeSession.current === target) setError(cause instanceof Error ? cause.message : "模式切换失败");
    } finally { inFlight.current = false; setPending(false); }
  };
  const label = mode?.options.find(option => option.value === current)?.label ?? "模式";
  return <div ref={root} className="harness-mode-control">
    <button type="button" className="ui-icon-button" aria-label={`运行模式：${label}`} title={`运行模式：${label}`} aria-haspopup="menu" aria-expanded={open} disabled={pending} onClick={() => setOpen(value => !value)}>
      <SlidersHorizontal size={17} aria-hidden="true" />
    </button>
    {open && <div className="web-native-permission-menu" role="menu" aria-label="DeepSeek Harness 模式">
      {(mode?.options ?? []).map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={current === option.value} className={current === option.value ? "is-active" : ""} disabled={pending || !mode?.canChange || !window.agentApi?.setSessionNativeMode} title={option.description} onClick={() => void select(option.value)}>
        <span className="web-native-permission-check" aria-hidden="true">{current === option.value ? "✓" : ""}</span><span>{option.label}</span>
      </button>)}
      {!mode?.canChange && <p className="harness-mode-note">请在新会话的第一条消息前选择模式</p>}
      {mode?.options.length === 0 && <p className="harness-mode-note">运行时未提供模式列表</p>}
      {error && <p className="harness-mode-note" role="alert">{error}</p>}
    </div>}
  </div>;
}
