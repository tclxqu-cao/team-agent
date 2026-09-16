import { ChevronDown, LoaderCircle } from "lucide-react";
import type { ReactNode } from "react";

export default function LiveViewSelect({ label, title, value, busy, disabled, compact, onChange, children }: {
  label: string;
  title?: string;
  value: string;
  busy: boolean;
  disabled: boolean;
  compact?: boolean;
  onChange(value: string): void;
  children: ReactNode;
}) {
  return (
    <span className={`live-view-select${compact ? " live-view-select--compact" : ""}`}>
      <select aria-label={label} aria-busy={busy} title={title} value={value} disabled={disabled || busy} onChange={event => onChange(event.target.value)}>
        {children}
      </select>
      {busy
        ? <span className="live-view-select-icon" role="status" aria-label={`${label}正在切换`}><LoaderCircle size={14} className="spin" aria-hidden="true" /></span>
        : <ChevronDown size={14} className="live-view-select-icon" aria-hidden="true" />}
    </span>
  );
}
