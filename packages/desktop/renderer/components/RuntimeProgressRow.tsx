import type { RuntimeProgress } from "@agent/core";

export default function RuntimeProgressRow({
  progress,
  compact = false,
}: {
  progress: RuntimeProgress;
  compact?: boolean;
}) {
  const detail = progress.detail
    ?? (progress.elapsedSeconds === undefined ? undefined : `${Math.round(progress.elapsedSeconds)} 秒`);
  const accessibleText = [progress.label, detail].filter(Boolean).join("，");
  return (
    <div
      className={`runtime-progress-row${compact ? " runtime-progress-row--compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={accessibleText}
    >
      <span className="runtime-progress-row__spinner" aria-hidden="true" />
      <span className="runtime-progress-row__label">{progress.label}</span>
      {detail && <span className="runtime-progress-row__detail">{detail}</span>}
    </div>
  );
}
