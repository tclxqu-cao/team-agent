import React from "react";
import path from "node:path";
import { Box, Text } from "ink";
import type { RuntimeSnapshot } from "../runtime.js";
import { TUI_THEME } from "../theme.js";

export function Header({ snapshot, running }: { snapshot: RuntimeSnapshot; running: boolean }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={running ? TUI_THEME.progress : TUI_THEME.active} paddingX={1}>
      <Box justifyContent="space-between">
        <Text color={TUI_THEME.agent} bold>CUSTOMER AGENT</Text>
        <Text color={running ? TUI_THEME.progress : TUI_THEME.ready} bold>
          {running ? "● 运行中" : "● 就绪"}
        </Text>
      </Box>
      <Box>
        <Text color={TUI_THEME.muted}>模型 </Text>
        <Box flexGrow={1}>
          <Text wrap="truncate">{snapshot.model.provider}/{snapshot.model.modelId}</Text>
        </Box>
      </Box>
      <Box>
        <Text color={TUI_THEME.muted}>项目 </Text>
        <Box flexGrow={1}>
          <Text color={TUI_THEME.user} wrap="truncate">{path.basename(snapshot.workingDirectory)}</Text>
        </Box>
        <Text color={TUI_THEME.muted}>  会话 </Text>
        <Text>{snapshot.sessionId.slice(0, 8)}</Text>
      </Box>
    </Box>
  );
}
