import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { formatElapsed, type ProgressState } from "../state.js";
import { TUI_THEME } from "../theme.js";

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
    ? `  tokens ↑${progress.usage.inputTokens} ↓${progress.usage.outputTokens}`
    : "";
  return (
    <Box marginTop={1}>
      <Text color={progress.completedAt ? TUI_THEME.ready : TUI_THEME.progress} bold>
        {progress.completedAt ? "✓ 完成" : "● " + progress.label}
      </Text>
      <Text color={TUI_THEME.muted}>  {formatElapsed(endedAt - progress.startedAt)}{usage}</Text>
    </Box>
  );
}
