import type { RuntimeProgress } from "@agent/core";
import { Brain, CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
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
  const settled = progress.status && !["running", "stopping"].includes(progress.status);
  const failed = progress.status === "failed" || progress.status === "killed";
  return (
    <div className="runtime-progress" data-status={progress.status}>
      <div
        className={`runtime-progress-row${compact ? " runtime-progress-row--compact" : ""}`}
        role="status"
        aria-live="polite"
        aria-label={accessibleText}
      >
        {settled ? (
          failed ? <CircleAlert size={14} aria-hidden="true" /> : <CheckCircle2 size={14} aria-hidden="true" />
        ) : showThinkingIcon ? (
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
        {progress.startedAt !== undefined && !settled && <ElapsedTime startedAt={progress.startedAt} />}
        {settled && progress.elapsedSeconds !== undefined && <span>{Math.round(progress.elapsedSeconds)} 秒</span>}
      </div>
      {progress.output !== undefined && (
        <details className="runtime-progress-output">
          <summary>实时输出</summary>
          <pre>{progress.output || "暂无输出"}</pre>
        </details>
      )}
    </div>
  );
}
