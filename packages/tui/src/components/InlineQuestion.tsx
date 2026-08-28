import React from "react";
import { Box, Text } from "ink";
import type { AskUserRequest } from "@agent/core";
import { TUI_THEME } from "../theme.js";

export function InlineQuestion({ request }: { request: AskUserRequest }) {
  return (
    <Box flexDirection="column" marginTop={1} paddingLeft={1}>
      <Text color={TUI_THEME.progress} bold>? {request.question}</Text>
      {(request.options ?? []).map((option, index) => (
        <Text key={`${index}:${option.label}`}>  <Text color={TUI_THEME.progress}>{index + 1}.</Text> <Text bold>{option.label}</Text>{option.description ? <Text dimColor>  {option.description}</Text> : null}</Text>
      ))}
      {(request.fields ?? []).map((field) => (
        <Text key={field.name}>  <Text color={TUI_THEME.progress}>•</Text> {field.label || field.name}{field.type === "secret" ? <Text dimColor>（敏感）</Text> : null}</Text>
      ))}
    </Box>
  );
}
