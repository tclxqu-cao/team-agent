import type { RuntimeProgress } from "@agent/core";
import { Brain, LoaderCircle } from "lucide-react";
import ElapsedTime from "./ElapsedTime";

export default function RuntimeProgressRow({
  progress,
  compact = false,
  startedAt,
}: {
  progress: RuntimeProgress;
  compact?: boolean;
  startedAt?: number;
}) {
  const detail = progress.detail
    ?? (progress.elapsedSeconds === undefined ? undefined : `${Math.round(progress.elapsedSeconds)} 秒`);
  const accessibleText = [progress.label, detail].filter(Boolean).join("，");
  const showThinkingIcon = !compact && progress.phase === "thinking";
  const showStatusIcon = !compact && progress.phase === "status";
  const showLiveElapsed = showThinkingIcon && startedAt !== undefined && detail === undefined;
  return (
    <div
      className={`runtime-progress-row${compact ? " runtime-progress-row--compact" : ""}`}
      role="status"
      aria-live="polite"
      aria-label={accessibleText}
    >
      {showThinkingIcon ? (
        <span className="runtime-progress-row__brain" aria-hidden="true">
          <Brain size={17} strokeWidth={1.8} />
        </span>
      ) : showStatusIcon ? (
        <span className="runtime-progress-row__status-icon" aria-hidden="true">
          <LoaderCircle size={17} strokeWidth={1.8} />
        </span>
      ) : (
        <span className="runtime-progress-row__spinner" aria-hidden="true" />
      )}
      <span className="runtime-progress-row__label">{progress.label}</span>
      {detail && <span className="runtime-progress-row__detail">{detail}</span>}
      {showLiveElapsed && <ElapsedTime startedAt={startedAt} />}
    </div>
  );
}
