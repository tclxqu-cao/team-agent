import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import type { UnifiedSessionSummary } from "../global";

type Mode = NonNullable<UnifiedSessionSummary["nativeMode"]>;

export default function HarnessModeControl({ sessionId, mode, prepareSession, onSessionPrepared }: {
  sessionId: string | null;
  mode?: Mode;
  prepareSession?: () => Promise<UnifiedSessionSummary>;
  onSessionPrepared?: (session: UnifiedSessionSummary) => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(mode?.currentValue);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const prepared = useRef<UnifiedSessionSummary | null>(null);
  const effectiveSessionId = sessionId ?? prepared.current?.id ?? null;
  const effectiveMode = mode ?? prepared.current?.nativeMode;
  const activeSession = useRef(sessionId);
  activeSession.current = effectiveSessionId;
  useEffect(() => {
    const activatingPreparedSession = prepared.current?.id === sessionId;
    prepared.current = null;
    setCurrent(mode?.currentValue);
    if (!activatingPreparedSession) setOpen(false);
    setError(null);
  }, [sessionId, mode?.currentValue]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [open]);
  const toggle = async () => {
    if (inFlight.current) return;
    if (effectiveSessionId || !prepareSession) { setOpen(value => !value); return; }
    inFlight.current = true; setPending(true); setError(null);
    try {
      const created = await prepareSession();
      prepared.current = created;
      activeSession.current = created.id;
      setCurrent(created.nativeMode?.currentValue);
      setOpen(true);
      await onSessionPrepared?.(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "模式加载失败");
      setOpen(true);
    } finally { inFlight.current = false; setPending(false); }
  };
  const select = async (value: string) => {
    if (!effectiveSessionId || !effectiveMode?.canChange || !window.agentApi?.setSessionNativeMode || inFlight.current) return;
    const target = effectiveSessionId;
    inFlight.current = true; setPending(true); setError(null);
    try {
      const updated = await window.agentApi.setSessionNativeMode(target, value);
      if (activeSession.current === target) { setCurrent(updated.nativeMode?.currentValue); setOpen(false); }
    } catch (cause) {
      if (activeSession.current === target) setError(cause instanceof Error ? cause.message : "模式切换失败");
    } finally { inFlight.current = false; setPending(false); }
  };
  const label = effectiveMode?.options.find(option => option.value === current)?.label ?? "模式";
  return <div ref={root} className="harness-mode-control">
    <button type="button" className="ui-icon-button" aria-label={`运行模式：${label}`} title={`运行模式：${label}`} aria-haspopup="menu" aria-expanded={open} disabled={pending} onClick={() => void toggle()}>
      <SlidersHorizontal size={17} aria-hidden="true" />
    </button>
    {open && <div className="web-native-permission-menu" role="menu" aria-label="DeepSeek Harness 模式">
      {(effectiveMode?.options ?? []).map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={current === option.value} className={current === option.value ? "is-active" : ""} disabled={pending || !effectiveMode?.canChange || !window.agentApi?.setSessionNativeMode} title={option.description} onClick={() => void select(option.value)}>
        <span className="web-native-permission-check" aria-hidden="true">{current === option.value ? "✓" : ""}</span><span>{option.label}</span>
      </button>)}
      {effectiveSessionId && effectiveMode?.canChange === false && <p className="harness-mode-note">请在新会话的第一条消息前选择模式</p>}
      {effectiveMode?.options.length === 0 && <p className="harness-mode-note">运行时未提供模式列表</p>}
      {error && <p className="harness-mode-note" role="alert">{error}</p>}
    </div>}
  </div>;
}
