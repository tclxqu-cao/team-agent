import React from "react";
import { Box, Text } from "ink";
import type { TranscriptEntry } from "../state.js";

function Entry({ entry }: { entry: TranscriptEntry }) {
  if (entry.type === "user") return <Text><Text color="green">you  </Text>{entry.text}</Text>;
  if (entry.type === "assistant") return <Text><Text color="cyan">agent  </Text>{entry.text}</Text>;
  if (entry.type === "error") return <Text color="red">x {entry.text}</Text>;
  if (entry.type === "notice") return <Text dimColor>{entry.text}</Text>;
  return (
    <Text color={entry.error ? "red" : undefined}>
      <Text color={entry.error ? "red" : "magenta"}>{entry.name === "结果" ? "  ->" : `tool ${entry.name}`}</Text>
      {entry.text ? ` ${entry.text}` : ""}
    </Text>
  );
}

export function Transcript({ entries, maxRows = 80 }: { entries: TranscriptEntry[]; maxRows?: number }) {
  const visible = entries.slice(-maxRows);
  return (
    <Box flexDirection="column">
      {visible.map((entry) => <Entry key={entry.id} entry={entry} />)}
    </Box>
  );
}
