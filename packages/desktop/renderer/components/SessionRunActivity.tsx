import type { RuntimeProgress } from "@agent/core";
import { ExecutionActivityPlaceholder } from "./ExecutionTrace";

/** Before the first process block arrives, reserve its summary in the same style. */
export default function SessionRunActivity({
  running,
  progress,
}: {
  running: boolean;
  progress?: RuntimeProgress;
}) {
  if (!running) return null;
  const summary = progress && progress.phase !== "thinking"
    && (!progress.status || progress.status === "running" || progress.status === "stopping")
    ? progress.label : undefined;
  return <ExecutionActivityPlaceholder summary={summary} />;
}
