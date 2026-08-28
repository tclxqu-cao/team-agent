import React from "react";
import { Box, Text } from "ink";
import type { TranscriptEntry } from "../state.js";
import { ROLE_LABELS, TUI_THEME } from "../theme.js";

function Entry({ entry }: { entry: TranscriptEntry }) {
  let label: string;
  let color: string;
  let text = entry.text;
  let dimmed = false;

  if (entry.type === "user") {
    label = ROLE_LABELS.user;
    color = TUI_THEME.user;
  } else if (entry.type === "assistant") {
    label = ROLE_LABELS.assistant;
    color = TUI_THEME.agent;
  } else if (entry.type === "error") {
    label = ROLE_LABELS.error;
    color = TUI_THEME.error;
  } else if (entry.type === "notice") {
    label = ROLE_LABELS.notice;
    color = TUI_THEME.muted;
    dimmed = true;
  } else {
    const result = entry.name === "结果" || entry.name === "失败";
    label = result ? ROLE_LABELS.result : ROLE_LABELS.tool;
    color = entry.error ? TUI_THEME.error : result ? TUI_THEME.muted : TUI_THEME.tool;
    text = result ? entry.text : `${entry.name}${entry.text ? `  ${entry.text}` : ""}`;
    dimmed = result && !entry.error;
  }

  return (
    <Box>
      <Box width={8} flexShrink={0}>
        <Text color={color} bold={!dimmed}>{label}</Text>
      </Box>
      <Box flexGrow={1}>
        <Text color={entry.type === "error" || (entry.type === "tool" && entry.error) ? TUI_THEME.error : undefined} dimColor={dimmed} wrap="wrap">
          {text}
        </Text>
      </Box>
    </Box>
  );
}

export function Transcript({ entries, maxRows = 80 }: { entries: TranscriptEntry[]; maxRows?: number }) {
  const visible = entries.slice(-maxRows);
  return (
    <Box flexDirection="column" marginTop={1}>
      {visible.length === 0 ? (
        <Box flexDirection="column" paddingLeft={1}>
          <Text color={TUI_THEME.text} bold>开始一个任务</Text>
          <Text color={TUI_THEME.muted}>输入消息，或用 <Text color={TUI_THEME.active}>/</Text> 打开命令与技能，用 <Text color={TUI_THEME.user}>@</Text> 引用项目文件。</Text>
        </Box>
      ) : visible.map((entry) => <Entry key={entry.id} entry={entry} />)}
    </Box>
  );
}
