import React from "react";
import { Box, Text, useInput } from "ink";

function previousIndex(value: string, cursor: number): number {
  if (cursor <= 0) return 0;
  const code = value.charCodeAt(cursor - 1);
  return code >= 0xdc00 && code <= 0xdfff && cursor > 1 ? cursor - 2 : cursor - 1;
}

function nextIndex(value: string, cursor: number): number {
  if (cursor >= value.length) return value.length;
  const code = value.charCodeAt(cursor);
  return code >= 0xd800 && code <= 0xdbff ? Math.min(value.length, cursor + 2) : cursor + 1;
}

export interface ComposerProps {
  input: string;
  cursor: number;
  running: boolean;
  questionActive: boolean;
  paletteOpen: boolean;
  onChange(input: string, cursor: number): void;
  onSubmit(): void;
  onHistory(direction: -1 | 1): void;
  onPaletteMove(direction: -1 | 1): void;
  onPaletteSelect(): void;
  onPaletteClose(): void;
  onAbort(): void;
  onExit(): void;
}

export function Composer(props: ComposerProps) {
  useInput((typed, key) => {
    if (key.ctrl && typed === "c") {
      if (props.running) props.onAbort();
      else props.onExit();
      return;
    }
    if (props.running && !props.questionActive) return;
    if (key.escape && props.paletteOpen) {
      props.onPaletteClose();
      return;
    }
    if (key.upArrow) {
      if (props.paletteOpen) props.onPaletteMove(-1);
      else props.onHistory(-1);
      return;
    }
    if (key.downArrow) {
      if (props.paletteOpen) props.onPaletteMove(1);
      else props.onHistory(1);
      return;
    }
    if (key.return) {
      if (props.paletteOpen) props.onPaletteSelect();
      else props.onSubmit();
      return;
    }
    if (key.leftArrow) {
      props.onChange(props.input, previousIndex(props.input, props.cursor));
      return;
    }
    if (key.rightArrow) {
      props.onChange(props.input, nextIndex(props.input, props.cursor));
      return;
    }
    if (key.backspace || key.delete) {
      if (props.cursor <= 0) return;
      const previous = previousIndex(props.input, props.cursor);
      props.onChange(props.input.slice(0, previous) + props.input.slice(props.cursor), previous);
      return;
    }
    if (!typed || key.ctrl || key.meta || key.tab) return;
    const clean = typed.replace(/[\r\n]+/g, " ");
    props.onChange(
      props.input.slice(0, props.cursor) + clean + props.input.slice(props.cursor),
      props.cursor + clean.length,
    );
  });

  const before = props.input.slice(0, props.cursor);
  const next = props.input.slice(props.cursor, nextIndex(props.input, props.cursor)) || " ";
  const after = props.input.slice(props.cursor + (next === " " && props.cursor === props.input.length ? 0 : next.length));
  return (
    <Box>
      <Text color={props.running ? "yellow" : "green"}>{props.running ? "... " : "> "}</Text>
      <Text>{before}</Text><Text inverse>{next}</Text><Text>{after}</Text>
    </Box>
  );
}
