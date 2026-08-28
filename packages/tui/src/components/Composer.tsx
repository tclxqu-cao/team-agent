import React, { useEffect, useRef } from "react";
import { Box, Text, useStdin } from "ink";
import { TUI_THEME } from "../theme.js";
import { getActiveTrigger } from "../palette.js";
import { parseTerminalInput, type TerminalInputToken } from "../terminal-input.js";

const ESCAPE_SEQUENCE_WINDOW_MS = 100;

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
  const { internal_eventEmitter: inputEvents, setRawMode } = useStdin();
  const propsRef = useRef(props);
  const draftRef = useRef({ input: props.input, cursor: props.cursor });
  const paletteIntentRef = useRef(props.paletteOpen);
  const pendingPaletteActions = useRef<Array<(current: ComposerProps) => void>>([]);
  const inputBuffer = useRef("");
  const escapeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  propsRef.current = props;
  draftRef.current = { input: props.input, cursor: props.cursor };
  paletteIntentRef.current = props.paletteOpen;

  const clearEscapeTimer = () => {
    if (escapeTimer.current) clearTimeout(escapeTimer.current);
    escapeTimer.current = null;
  };

  const deferPaletteAction = (action: (current: ComposerProps) => void) => {
    pendingPaletteActions.current.push(action);
  };

  useEffect(() => {
    if (!props.paletteOpen) {
      pendingPaletteActions.current = [];
      return;
    }
    if (pendingPaletteActions.current.length === 0) return;
    const actions = pendingPaletteActions.current.splice(0);
    const timer = setTimeout(() => {
      const current = propsRef.current;
      if (!current.paletteOpen) return;
      for (const action of actions) action(current);
    }, 0);
    return () => clearTimeout(timer);
  }, [props.paletteOpen]);

  const updateDraft = (input: string, cursor: number) => {
    draftRef.current = { input, cursor };
    paletteIntentRef.current = Boolean(getActiveTrigger(input, cursor));
    if (!paletteIntentRef.current && !propsRef.current.paletteOpen) pendingPaletteActions.current = [];
    propsRef.current.onChange(input, cursor);
  };

  const handleToken = (token: TerminalInputToken) => {
    const current = propsRef.current;
    if (token.type === "ctrl_c") {
      if (current.running) current.onAbort();
      else current.onExit();
      return;
    }
    if (current.running && !current.questionActive) return;

    if (token.type === "up" || token.type === "down") {
      const direction = token.type === "up" ? -1 : 1;
      if (current.paletteOpen) current.onPaletteMove(direction);
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteMove(direction));
      else current.onHistory(direction);
      return;
    }
    if (token.type === "escape") {
      if (current.paletteOpen) current.onPaletteClose();
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteClose());
      return;
    }
    if (token.type === "enter") {
      if (current.paletteOpen) current.onPaletteSelect();
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteSelect());
      else current.onSubmit();
      return;
    }

    const draft = draftRef.current;
    if (token.type === "left") {
      updateDraft(draft.input, previousIndex(draft.input, draft.cursor));
      return;
    }
    if (token.type === "right") {
      updateDraft(draft.input, nextIndex(draft.input, draft.cursor));
      return;
    }
    if (token.type === "backspace" || token.type === "delete") {
      if (draft.cursor <= 0) return;
      const previous = previousIndex(draft.input, draft.cursor);
      updateDraft(draft.input.slice(0, previous) + draft.input.slice(draft.cursor), previous);
      return;
    }
    if (token.type !== "text") return;
    const clean = token.value.replace(/[\r\n]+/g, " ");
    updateDraft(
      draft.input.slice(0, draft.cursor) + clean + draft.input.slice(draft.cursor),
      draft.cursor + clean.length,
    );
  };

  const handleTokenRef = useRef(handleToken);
  handleTokenRef.current = handleToken;

  useEffect(() => {
    const drain = (flushEscape: boolean) => {
      const parsed = parseTerminalInput(inputBuffer.current, flushEscape);
      inputBuffer.current = parsed.remainder;
      for (const token of parsed.tokens) handleTokenRef.current(token);
    };
    const scheduleEscapeFlush = () => {
      clearEscapeTimer();
      escapeTimer.current = setTimeout(() => drain(true), ESCAPE_SEQUENCE_WINDOW_MS);
    };
    const onInput = (data: unknown) => {
      clearEscapeTimer();
      inputBuffer.current += String(data ?? "");
      drain(false);
      if (inputBuffer.current) scheduleEscapeFlush();
    };

    setRawMode(true);
    inputEvents.on("input", onInput);
    return () => {
      clearEscapeTimer();
      inputEvents.removeListener("input", onInput);
      setRawMode(false);
    };
  }, [inputEvents, setRawMode]);

  const before = props.input.slice(0, props.cursor);
  const next = props.input.slice(props.cursor, nextIndex(props.input, props.cursor)) || " ";
  const after = props.input.slice(props.cursor + (next === " " && props.cursor === props.input.length ? 0 : next.length));
  const color = props.questionActive ? TUI_THEME.progress : props.running ? TUI_THEME.progress : props.paletteOpen ? TUI_THEME.active : TUI_THEME.ready;
  const label = props.questionActive ? "回答" : props.running ? "运行中" : props.paletteOpen ? "筛选" : "消息";
  const hint = props.questionActive
    ? "输入序号或答案  Enter 提交  Ctrl+C 取消"
    : props.paletteOpen
      ? "输入筛选  ↑↓ 移动  Enter 选择  Backspace 退出  Esc 关闭"
      : "/ 命令  @ 引用  Enter 发送  Ctrl+C 退出";
  return (
    <Box flexDirection="column">
      <Text color={color} bold>{label}</Text>
      {props.paletteOpen ? (
        <Text><Text color={TUI_THEME.active}>⌕ </Text><Text color={TUI_THEME.muted}>{props.input || "输入关键词"}</Text></Text>
      ) : (
        <Box>
          <Text color={color}>{props.running && !props.questionActive ? "… " : "› "}</Text>
          <Text>{before}</Text><Text inverse>{next}</Text><Text>{after}</Text>
        </Box>
      )}
      <Text color={TUI_THEME.muted}>{hint}</Text>
    </Box>
  );
}
