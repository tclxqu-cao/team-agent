import React from "react";
import { Box, Text } from "ink";
import { TUI_THEME } from "../theme.js";

export function MessageQueue({ items, maxRows = 3 }: { items: string[]; maxRows?: number }) {
  if (items.length === 0) return null;
  const visible = items.slice(0, maxRows);
  return (
    <Box marginTop={1} alignItems="flex-start">
      <Box width={7} flexShrink={0}>
        <Text color={TUI_THEME.progress} bold>QUEUE</Text>
      </Box>
      <Box
        flexGrow={1}
        flexDirection="column"
        paddingLeft={1}
        borderStyle="single"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeftColor={TUI_THEME.progress}
      >
        {visible.map((item, index) => (
          <Text key={`${index}:${item}`} color={TUI_THEME.text} wrap="truncate">
            <Text color={TUI_THEME.progress}>{index + 1}.</Text> {item}
          </Text>
        ))}
        {items.length > visible.length ? (
          <Text color={TUI_THEME.muted}>另有 {items.length - visible.length} 条待执行</Text>
        ) : null}
      </Box>
    </Box>
  );
}
