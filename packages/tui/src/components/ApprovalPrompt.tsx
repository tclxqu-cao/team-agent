import React from "react";
import { Box, Text } from "ink";
import type { ToolPermissionRequest } from "@agent/core";
import { TOOL_APPROVAL_OPTIONS } from "@agent/core";
import { TUI_THEME } from "../theme.js";

const MODE_HINTS: Record<string, string> = {
  "request-approval": "审批模式：所有执行类工具都会询问",
  "auto-approval": "审批模式：仅高风险操作询问",
  "full-access": "审批模式：全部自动放行",
};

export function ApprovalPrompt({ request, mode }: { request: ToolPermissionRequest; mode?: string }) {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1} borderStyle="round" borderColor={TUI_THEME.progress} paddingX={1}>
      <Text color={TUI_THEME.progress} bold>⚠ 工具执行审批{mode ? <Text dimColor>  ({MODE_HINTS[mode] ?? mode})</Text> : null}</Text>
      <Text wrap="truncate"><Text bold>{request.toolName}</Text><Text>  {request.summary}</Text></Text>
      <Text dimColor>{request.reason}</Text>
      {TOOL_APPROVAL_OPTIONS.map((option, index) => (
        <Text key={option.label}>  <Text color={TUI_THEME.progress}>{index + 1}.</Text> <Text bold>{option.label}</Text><Text dimColor>  {option.description}</Text></Text>
      ))}
    </Box>
  );
}
