import React from "react";
import { Box, Text } from "ink";
import type { TranscriptEntry } from "../state.js";
import { ROLE_GLYPHS, TUI_THEME } from "../theme.js";
import { MarkdownText } from "./MarkdownText.js";

function Entry({ entry, separated }: { entry: TranscriptEntry; separated: boolean }) {
  let label: string;
  let color: string;
  let text = entry.text;
  let dimmed = false;

  if (entry.type === "user") {
    label = ROLE_GLYPHS.user;
    color = TUI_THEME.user;
  } else if (entry.type === "assistant") {
    label = ROLE_GLYPHS.assistant;
    color = TUI_THEME.agent;
  } else if (entry.type === "error") {
    label = ROLE_GLYPHS.error;
    color = TUI_THEME.error;
  } else if (entry.type === "notice") {
    label = ROLE_GLYPHS.notice;
    color = TUI_THEME.muted;
    dimmed = true;
  } else {
    const result = entry.name === "结果" || entry.name === "失败";
    label = result ? ROLE_GLYPHS.result : ROLE_GLYPHS.tool;
    color = entry.error ? TUI_THEME.error : result ? TUI_THEME.muted : TUI_THEME.tool;
    text = result ? entry.text : `${entry.name}${entry.text ? `  ${entry.text}` : ""}`;
    dimmed = result && !entry.error;
  }

  return (
    <Box marginTop={separated ? 1 : 0} alignItems="flex-start">
      <Box width={3} flexShrink={0}>
        <Text color={color} bold={!dimmed}>{label}</Text>
      </Box>
      <Box
        flexGrow={1}
        flexDirection="column"
        paddingLeft={1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeftColor={color}
      >
        {entry.type === "assistant" ? (
          <MarkdownText>{text}</MarkdownText>
        ) : (
          <Text color={entry.type === "error" || (entry.type === "tool" && entry.error) ? TUI_THEME.error : TUI_THEME.text} dimColor={dimmed} wrap="wrap">
            {text}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function Transcript({ entries, maxRows = 80 }: { entries: TranscriptEntry[]; maxRows?: number }) {
  const visible = entries.slice(-maxRows);
  return (
    <Box flexDirection="column" marginTop={visible.length ? 1 : 0}>
      {visible.map((entry, index) => <Entry key={entry.id} entry={entry} separated={index > 0 && entry.type === "user"} />)}
    </Box>
  );
}
