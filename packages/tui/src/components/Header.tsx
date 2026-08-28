import React from "react";
import path from "node:path";
import { Box, Text, useStdout } from "ink";
import type { RuntimeSnapshot } from "../runtime.js";
import { TUI_THEME } from "../theme.js";

const MONOGRAM = [
  ["  █████  ", "  ███  "],
  [" ██      ", " ██ ██ "],
  [" ██      ", " █████ "],
  [" ██      ", " ██ ██ "],
  ["  █████  ", " ██ ██ "],
] as const;

export function Header({
  snapshot,
  running,
  expanded = true,
}: {
  snapshot: RuntimeSnapshot;
  running: boolean;
  expanded?: boolean;
}) {
  const { stdout } = useStdout();
  const compact = (stdout.columns || 80) < 64;
  const project = path.basename(snapshot.workingDirectory);
  const model = `${snapshot.model.provider}/${snapshot.model.modelId}`;
  const session = `#${snapshot.sessionId.slice(0, 8)}`;
  const statusColor = running ? TUI_THEME.progress : TUI_THEME.ready;
  const status = running ? "● RUNNING" : "● READY";

  if (!expanded) {
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          <Text>
            <Text color={TUI_THEME.spark}>◆</Text>
            <Text color={TUI_THEME.strong} bold> CUSTOMER AGENT</Text>
          </Text>
          <Text color={statusColor} bold>{status}</Text>
        </Box>
        <Text wrap="truncate">
          <Text color={TUI_THEME.user} bold>{project}</Text>
          <Text color={TUI_THEME.faint}>  ·  </Text>
          <Text color={TUI_THEME.text}>{model}</Text>
          <Text color={TUI_THEME.faint}>  ·  </Text>
          <Text color={TUI_THEME.muted}>{session}</Text>
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
      {MONOGRAM.map(([left, right], index) => (
        <Box key={index}>
          <Text color={TUI_THEME.brand} bold>{left}</Text>
          <Text color={TUI_THEME.spark} bold>{right}</Text>
          {index === 0 ? <Text color={TUI_THEME.strong} bold>  CUSTOMER</Text> : null}
          {index === 1 ? <Text color={TUI_THEME.strong} bold>  AGENT</Text> : null}
          {index === 3 ? <Text color={statusColor} bold>  {status}</Text> : null}
        </Box>
      ))}
      {compact ? (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate">
            <Text color={TUI_THEME.user} bold>{project}</Text>
            <Text color={TUI_THEME.faint}>  ·  </Text>
            <Text color={TUI_THEME.muted}>{session}</Text>
          </Text>
          <Text color={TUI_THEME.text} wrap="truncate">{model}</Text>
        </Box>
      ) : (
        <Text wrap="truncate">
          <Text color={TUI_THEME.user} bold>{project}</Text>
          <Text color={TUI_THEME.faint}>  ·  </Text>
          <Text color={TUI_THEME.text}>{model}</Text>
          <Text color={TUI_THEME.faint}>  ·  </Text>
          <Text color={TUI_THEME.muted}>{session}</Text>
        </Text>
      )}
    </Box>
  );
}
