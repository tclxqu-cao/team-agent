import React, { useEffect, useState } from "react";
import { Text } from "ink";
import { formatElapsed, type ProgressState } from "../state.js";

export function ProgressLine({ progress }: { progress: ProgressState | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!progress || progress.completedAt) return;
    const timer = setInterval(() => setTick((value) => value + 1), 100);
    return () => clearInterval(timer);
  }, [progress?.startedAt, progress?.completedAt]);
  if (!progress) return null;
  const endedAt = progress.completedAt ?? Date.now();
  const usage = progress.usage
    ? ` · tokens ${progress.usage.inputTokens}/${progress.usage.outputTokens}`
    : "";
  return (
    <Text dimColor>
      {progress.completedAt ? "done 完成" : `... ${progress.label}`} · {formatElapsed(endedAt - progress.startedAt)}{usage}
    </Text>
  );
}
