import React from "react";
import { Box, Text } from "ink";
import type { PaletteItem } from "../palette.js";

const GROUP_LABEL: Record<PaletteItem["kind"], string> = {
  command: "Commands",
  skill: "Skills",
  project: "Projects",
  folder: "Folders",
  file: "Files",
  model: "Models",
  session: "Sessions",
  action: "Actions",
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
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      {title ? <Text bold>{title}</Text> : null}
      {items.length === 0 ? <Text dimColor>No matches</Text> : visible.map((item, offset) => {
        const index = start + offset;
        const showGroup = item.kind !== previousKind;
        previousKind = item.kind;
        return (
          <React.Fragment key={item.id}>
            {showGroup ? <Text dimColor>{GROUP_LABEL[item.kind]}</Text> : null}
            <Text
              color={item.disabled ? "gray" : index === selected ? "cyan" : undefined}
              inverse={index === selected && !item.disabled}
              wrap="truncate"
            >
              {index === selected ? "> " : "  "}{item.label}  <Text dimColor>{item.description}</Text>
            </Text>
          </React.Fragment>
        );
      })}
    </Box>
  );
}
