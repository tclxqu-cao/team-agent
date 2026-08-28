import React, { useEffect, useRef } from "react";
import { Box, Text, useStdin, useStdout } from "ink";
import { TUI_THEME } from "../theme.js";
import { getActiveTrigger } from "../palette.js";
import { parseTerminalInput, type TerminalInputToken } from "../terminal-input.js";
import { CURSOR_ANCHOR } from "../cursor-output.js";
import { maskSecret } from "../model-wizard.js";

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
  nativeCursor?: boolean;
  inputMode?: "message" | "model-url" | "model-key" | "model-fetching" | "model-select";
  onChange(input: string, cursor: number): void;
  onSubmit(): void;
  onHistory(direction: -1 | 1): void;
  onPaletteMove(direction: -1 | 1): void;
  onPaletteSelect(): void;
  onPaletteClose(): void;
  onAbort(): void;
  onExit(): void;
  onCancel?(): void;
}

export function Composer(props: ComposerProps) {
  const { internal_eventEmitter: inputEvents, setRawMode } = useStdin();
  const { stdout } = useStdout();
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
    paletteIntentRef.current = (!propsRef.current.inputMode || propsRef.current.inputMode === "message")
      && Boolean(getActiveTrigger(input, cursor));
    if (!paletteIntentRef.current && !propsRef.current.paletteOpen) pendingPaletteActions.current = [];
    propsRef.current.onChange(input, cursor);
  };

  const handleToken = (token: TerminalInputToken) => {
    const current = propsRef.current;
    if (token.type === "ctrl_c") {
      if (current.inputMode && current.inputMode !== "message") {
        current.onCancel?.();
        return;
      }
      if (current.running) current.onAbort();
      else current.onExit();
      return;
    }
    if (current.inputMode === "model-fetching") {
      if (token.type === "escape") current.onCancel?.();
      return;
    }
    if (token.type === "up" || token.type === "down") {
      const direction = token.type === "up" ? -1 : 1;
      if (current.paletteOpen) current.onPaletteMove(direction);
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteMove(direction));
      else if (!current.inputMode || current.inputMode === "message") current.onHistory(direction);
      return;
    }
    if (token.type === "escape") {
      if (current.paletteOpen) current.onPaletteClose();
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteClose());
      else if (current.inputMode && current.inputMode !== "message") current.onCancel?.();
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

  const secret = props.inputMode === "model-key" || props.inputMode === "model-fetching";
  const displayInput = secret ? maskSecret(props.input) : props.input;
  const before = displayInput.slice(0, props.cursor);
  const next = displayInput.slice(props.cursor, nextIndex(displayInput, props.cursor)) || " ";
  const after = displayInput.slice(props.cursor + (next === " " && props.cursor === displayInput.length ? 0 : next.length));
  const color = props.questionActive ? TUI_THEME.progress : props.running ? TUI_THEME.progress : props.paletteOpen ? TUI_THEME.active : TUI_THEME.ready;
  const hint = props.inputMode === "model-url"
    ? "https://api.example.com/v1"
    : props.inputMode === "model-key"
      ? "输入 API Key"
      : props.inputMode === "model-fetching"
        ? "正在获取模型列表"
        : props.questionActive
    ? "输入序号或答案"
    : props.paletteOpen
      ? "输入筛选"
      : props.running
        ? "排队发送消息"
        : "输入消息";
  const columns = stdout.columns || 80;
  const compact = columns < 64;
  const wizardInput = props.inputMode && props.inputMode !== "message";
  const leftHint = props.paletteOpen ? "筛选  ·  ↑↓ 选择  Enter 确认" : wizardInput ? "模型服务配置" : props.questionActive ? "Enter 提交" : "/ 命令  @ 引用";
  const rightHint = props.paletteOpen ? "Esc 关闭" : wizardInput ? (props.inputMode === "model-fetching" ? "Esc 取消" : "Enter 下一步   Esc 取消") : props.questionActive ? "Ctrl+C 取消" : props.running ? "Enter 排队   Ctrl+C 中止" : "Enter 发送   Ctrl+C 退出";
  const nativeCursor = props.nativeCursor;
  return (
    <Box flexDirection="column">
      <Box
        width="100%"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
      >
        <Box flexGrow={1}>
          <Text color={color}>{props.paletteOpen ? "⌕ " : wizardInput ? "◆ " : props.questionActive ? "? " : props.running ? "+ " : "› "}</Text>
          {props.paletteOpen ? (
            nativeCursor ? (
              <Text color={TUI_THEME.text}>{before}{CURSOR_ANCHOR}{props.input.slice(props.cursor)}{!props.input ? <Text color={TUI_THEME.muted}>{hint}</Text> : null}</Text>
            ) : (
              <Text color={props.input ? TUI_THEME.text : TUI_THEME.muted}>{props.input || hint}</Text>
            )
          ) : (
            <>
              {nativeCursor ? (
                <Text color={TUI_THEME.text}>{before}{CURSOR_ANCHOR}{displayInput.slice(props.cursor)}{!displayInput ? <Text color={TUI_THEME.muted}>{hint}</Text> : null}</Text>
              ) : (
                <Text color={TUI_THEME.text}>{before}</Text>
              )}
              {!nativeCursor ? <Text inverse={!props.nativeCursor}>{next}</Text> : null}
              {!nativeCursor ? <Text color={TUI_THEME.text}>{after}</Text> : null}
              {!nativeCursor && !props.input ? <Text color={TUI_THEME.muted}>{hint}</Text> : null}
            </>
          )}
        </Box>
      </Box>
      {compact ? (
        <Text color={TUI_THEME.muted}>  {leftHint}  ·  {rightHint}</Text>
      ) : (
        <Box paddingX={1} justifyContent="space-between">
          <Text color={TUI_THEME.muted}>{leftHint}</Text>
          <Text color={TUI_THEME.muted}>{rightHint}</Text>
        </Box>
      )}
    </Box>
  );
}
