import React from "react";
import { Box, Text } from "ink";
import type { PaletteItem } from "../palette.js";
import { TUI_THEME } from "../theme.js";

const GROUP_LABEL: Record<PaletteItem["kind"], string> = {
  command: "命令",
  skill: "技能",
  project: "项目",
  folder: "文件夹",
  file: "文件",
  model: "模型",
  session: "会话",
  action: "操作",
};

export function CommandPalette({
  items,
  selectedIndex,
  title,
  maxRows = 12,
}: {
  items: PaletteItem[];
  selectedIndex: number;
  title?: string;
  maxRows?: number;
}) {
  const selected = Math.max(0, Math.min(selectedIndex, Math.max(0, items.length - 1)));
  const start = Math.max(0, Math.min(selected - Math.floor(maxRows / 2), Math.max(0, items.length - maxRows)));
  const visible = items.slice(start, start + maxRows);
  let previousKind: PaletteItem["kind"] | null = null;
  return (
    <Box
      width="100%"
      flexDirection="column"
      marginBottom={1}
      paddingX={1}
      borderStyle="round"
      borderColor={TUI_THEME.faint}
    >
      <Box justifyContent="space-between">
        <Text><Text color={TUI_THEME.spark}>◆</Text><Text color={TUI_THEME.strong} bold> {title ?? "候选"}</Text></Text>
        <Text color={TUI_THEME.muted}>{items.length === 0 ? "0/0" : `${selected + 1}/${items.length}`}</Text>
      </Box>
      {items.length === 0 ? <Text color={TUI_THEME.muted}>没有匹配项</Text> : visible.map((item, offset) => {
        const index = start + offset;
        const showGroup = item.kind !== previousKind;
        previousKind = item.kind;
        const selectedRow = index === selected;
        const active = selectedRow && !item.disabled;
        const row = `${selectedRow ? "›" : " "} ${item.label}${item.description ? `  ${item.description}` : ""}`;
        return (
          <React.Fragment key={item.id}>
            {showGroup ? <Text color={TUI_THEME.muted}>  {GROUP_LABEL[item.kind]}</Text> : null}
            <Text
              color={item.disabled ? TUI_THEME.muted : active ? "black" : undefined}
              backgroundColor={active ? TUI_THEME.active : undefined}
              bold={active}
              dimColor={item.disabled}
              wrap="truncate"
            >
              {row}
            </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
