import React from "react";
import { Box, Text } from "ink";
import type { TranscriptEntry } from "../state.js";
import { ROLE_GLYPHS, TUI_THEME } from "../theme.js";
import { MarkdownText } from "./MarkdownText.js";

const LIVE_ROWS = 80;
const SCROLLBACK_ROWS = 200;

function DiffLines({ text }: { text: string }) {
  return (
    <Box flexDirection="column">
      {text.split("\n").map((line, index) => (
        <Text
          key={`${index}:${line.slice(0, 12)}`}
          wrap="wrap"
          color={line.startsWith("+")
            ? TUI_THEME.user
            : line.startsWith("-")
              ? TUI_THEME.error
              : line.startsWith("@@") || line.startsWith("***")
                ? TUI_THEME.muted
                : TUI_THEME.text}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}

function Entry({ entry, separated, expanded }: { entry: TranscriptEntry; separated: boolean; expanded: boolean }) {
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
    if (expanded && entry.type === "tool" && entry.full) text = entry.full;
    else text = result ? entry.text : `${entry.name}${entry.text ? `  ${entry.text}` : ""}`;
    dimmed = result && !entry.error;
  }

  const isPatch = expanded && entry.type === "tool" && Boolean(entry.full) && entry.name === "apply_patch";

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
        ) : isPatch && entry.full ? (
          <DiffLines text={entry.full} />
        ) : (
          <Text color={entry.type === "error" || (entry.type === "tool" && entry.error) ? TUI_THEME.error : TUI_THEME.text} dimColor={dimmed} wrap="wrap">
            {text}
          </Text>
        )}
      </Box>
    </Box>
  );
}

export function Transcript({ entries, offset = 0 }: { entries: TranscriptEntry[]; offset?: number }) {
  const total = entries.length;
  const scrolled = offset > 0;
  const maxRows = scrolled ? SCROLLBACK_ROWS : LIVE_ROWS;
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - maxRows);
  const visible = entries.slice(start, end);
  return (
    <Box flexDirection="column" marginTop={visible.length ? 1 : 0}>
      {scrolled ? (
        <Text color={TUI_THEME.progress}>── 回看 · 第 {start + 1}–{end} 条 / 共 {total} 条 ──  PgUp/PgDn 翻页 · Ctrl+O/Esc 返回实时</Text>
      ) : null}
      {visible.map((entry, index) => (
        <Entry key={entry.id} entry={entry} separated={index > 0 && entry.type === "user"} expanded={scrolled} />
      ))}
    </Box>
  );
}
