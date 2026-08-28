import React, { useEffect, useRef } from "react";
import { Box, Text, useInput, type Key } from "ink";
import { TUI_THEME } from "../theme.js";

const ESCAPE_SEQUENCE_WINDOW_MS = 100;

export function navigationDirection(typed: string, key: Pick<Key, "upArrow" | "downArrow">): -1 | 1 | null {
  if (key.upArrow || typed === "[A" || typed === "OA") return -1;
  if (key.downArrow || typed === "[B" || typed === "OB") return 1;
  return null;
}

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
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const escapeFragment = useRef("");

  const clearEscapeTimer = () => {
    if (escapeTimer.current) clearTimeout(escapeTimer.current);
    escapeTimer.current = null;
  };

  const schedulePaletteClose = () => {
    clearEscapeTimer();
    escapeTimer.current = setTimeout(() => {
      escapeFragment.current = "";
      props.onPaletteClose();
    }, ESCAPE_SEQUENCE_WINDOW_MS);
  };

  useEffect(() => () => clearEscapeTimer(), []);

  useInput((typed, key) => {
    if (key.ctrl && typed === "c") {
      if (props.running) props.onAbort();
      else props.onExit();
      return;
    }
    if (props.running && !props.questionActive) return;
    const direction = navigationDirection(typed, key);
    if (direction !== null) {
      clearEscapeTimer();
      escapeFragment.current = "";
      if (props.paletteOpen) props.onPaletteMove(direction);
      else props.onHistory(direction);
      return;
    }

    if (props.paletteOpen && escapeTimer.current && typed) {
      escapeFragment.current += typed;
      const fragmentedDirection = navigationDirection(escapeFragment.current, key);
      if (fragmentedDirection !== null) {
        clearEscapeTimer();
        escapeFragment.current = "";
        props.onPaletteMove(fragmentedDirection);
        return;
      }
      if (escapeFragment.current === "[" || escapeFragment.current === "O") {
        schedulePaletteClose();
        return;
      }
      clearEscapeTimer();
      escapeFragment.current = "";
      props.onPaletteClose();
      return;
    }

    if (key.escape && props.paletteOpen) {
      schedulePaletteClose();
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
  const color = props.questionActive ? TUI_THEME.progress : props.running ? TUI_THEME.progress : TUI_THEME.ready;
  const label = props.questionActive ? "回答" : props.running ? "运行中" : "消息";
  const hint = props.questionActive
    ? "输入序号或答案  Enter 提交  Ctrl+C 取消"
    : props.paletteOpen
      ? "候选已打开"
      : "/ 命令  @ 引用  Enter 发送  Ctrl+C 退出";
  return (
    <Box flexDirection="column">
      <Text color={color} bold>{label}</Text>
      <Box>
        <Text color={color}>{props.running && !props.questionActive ? "… " : "› "}</Text>
        <Text>{before}</Text><Text inverse>{next}</Text><Text>{after}</Text>
      </Box>
      <Text color={TUI_THEME.muted}>{hint}</Text>
    </Box>
  );
}
