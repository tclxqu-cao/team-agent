import React from "react";
import { Box, Text } from "ink";
import { formatElapsed, type ProgressState } from "../state.js";
import { ROLE_GLYPHS, TUI_THEME } from "../theme.js";

export function ProgressLine({ progress }: { progress: ProgressState | null }) {
  if (!progress) return null;
  const endedAt = progress.completedAt ?? Date.now();
  const usage = progress.usage
    ? `  tokens ↑${progress.usage.inputTokens} ↓${progress.usage.outputTokens}`
    : "";
  return (
    <Box marginTop={1}>
      <Box width={3} flexShrink={0}>
        <Text color={progress.completedAt ? TUI_THEME.ready : TUI_THEME.progress} bold>{progress.completedAt ? "✓" : ROLE_GLYPHS.progress}</Text>
      </Box>
      <Text color={TUI_THEME.faint}>│ </Text>
      <Text color={progress.completedAt ? TUI_THEME.ready : TUI_THEME.progress} bold>{progress.completedAt ? "完成" : progress.label}</Text>
      <Text color={TUI_THEME.muted}>  {formatElapsed(endedAt - progress.startedAt)}{usage}</Text>
    </Box>
  );
}
