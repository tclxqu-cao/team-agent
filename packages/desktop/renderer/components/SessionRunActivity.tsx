import type { RuntimeProgress } from "@agent/core";
import AgentActivityIndicator from "./AgentActivityIndicator";
import RuntimeProgressRow from "./RuntimeProgressRow";

/** Keep the run visible across model output, tools and background work. */
export default function SessionRunActivity({
  running,
  progress,
  startedAt,
}: {
  running: boolean;
  progress?: RuntimeProgress;
  startedAt: number;
}) {
  if (!running) return null;
  const settled = progress?.status && !["running", "stopping"].includes(progress.status);
  return (
    <>
      {progress && <RuntimeProgressRow progress={progress} startedAt={startedAt} />}
      {(!progress || settled) && (
        <div className="chat-message-activity" style={{
          display: "flex",
          alignItems: "flex-start",
          padding: "4px 0 4px",
        }}>
          <AgentActivityIndicator startedAt={startedAt} />
        </div>
      )}
    </>
  );
}
