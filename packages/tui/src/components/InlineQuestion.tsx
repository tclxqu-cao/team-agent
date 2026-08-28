import React from "react";
import { Box, Text } from "ink";
import type { AskUserRequest } from "@agent/core";

export function InlineQuestion({ request }: { request: AskUserRequest }) {
  return (
    <Box flexDirection="column">
      <Text color="yellow">? {request.question}</Text>
      {(request.options ?? []).map((option, index) => (
        <Text key={`${index}:${option.label}`}>  {index + 1}. <Text bold>{option.label}</Text>{option.description ? <Text dimColor> - {option.description}</Text> : null}</Text>
      ))}
      {(request.fields ?? []).map((field) => (
        <Text key={field.name}>  {field.label || field.name}{field.type === "secret" ? <Text dimColor> (sensitive)</Text> : null}</Text>
      ))}
    </Box>
  );
}
