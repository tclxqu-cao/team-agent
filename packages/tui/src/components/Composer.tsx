import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useStdin, useStdout } from "ink";
import { TUI_THEME } from "../theme.js";
import { getActiveTrigger } from "../palette.js";
import { parseTerminalInput, type TerminalInputToken } from "../terminal-input.js";
import { CURSOR_ANCHOR } from "../cursor-output.js";
import { applyVimKey, initialVimState, type VimMode, type VimState } from "../vim.js";
import { backspace, deleteWordBack, insertText, killToEnd, killToStart, moveDown, moveUp, onFirstLine, onLastLine, renderLines, wordLeft, wordRight } from "../text-editor.js";
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
  approvalActive?: boolean;
  paletteOpen: boolean;
  nativeCursor?: boolean;
  scrollback?: boolean;
  vimMode?: boolean;
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
  onPageUp?(): void;
  onPageDown?(): void;
  onToggleScrollback?(): void;
  onCloseScrollback?(): void;
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
  const vimStateRef = useRef<VimState>(initialVimState());
  const [vimIndicator, setVimIndicator] = useState<VimMode>("normal");
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
    if (current.vimMode && !current.paletteOpen && !paletteIntentRef.current
      && !current.questionActive && !current.approvalActive && !current.scrollback
      && (!current.inputMode || current.inputMode === "message")) {
      const draft = draftRef.current;
      const result = applyVimKey(vimStateRef.current, { input: draft.input, cursor: draft.cursor }, token);
      vimStateRef.current = result.state;
      if (vimStateRef.current.mode !== vimIndicator) setVimIndicator(vimStateRef.current.mode);
      if (result.consumed) {
        if (result.buffer.input !== draft.input || result.buffer.cursor !== draft.cursor) {
          updateDraft(result.buffer.input, result.buffer.cursor);
        }
        return;
      }
    }
    if (token.type === "ctrl_o") {
      if (!current.paletteOpen) current.onToggleScrollback?.();
      return;
    }
    if (token.type === "pageup" || token.type === "pagedown") {
      if (!current.paletteOpen) {
        if (token.type === "pageup") current.onPageUp?.();
        else current.onPageDown?.();
      }
      return;
    }
    if (token.type === "up" || token.type === "down") {
      const direction = token.type === "up" ? -1 : 1;
      if (current.paletteOpen) current.onPaletteMove(direction);
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteMove(direction));
      else if (!current.inputMode || current.inputMode === "message") {
        const draft = draftRef.current;
        const target = direction === -1 ? moveUp(draft.input, draft.cursor) : moveDown(draft.input, draft.cursor);
        const boundary = direction === -1 ? onFirstLine(draft.input, draft.cursor) : onLastLine(draft.input, draft.cursor);
        if (target !== null && !boundary) updateDraft(draft.input, target);
        else current.onHistory(direction);
      }
      return;
    }
    if (token.type === "escape") {
      if (current.paletteOpen) current.onPaletteClose();
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteClose());
      else if (current.scrollback) current.onCloseScrollback?.();
      else if (current.inputMode && current.inputMode !== "message") current.onCancel?.();
      return;
    }
    if (token.type === "enter") {
      if (current.paletteOpen) current.onPaletteSelect();
      else if (paletteIntentRef.current) deferPaletteAction((latest) => latest.onPaletteSelect());
      else {
        const draft = draftRef.current;
        if ((!current.inputMode || current.inputMode === "message") && draft.input.endsWith("\\")) {
          updateDraft(draft.input.slice(0, -1) + "\n", draft.input.length);
          return;
        }
        current.onSubmit();
      }
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
    if (token.type === "home") {
      const start = draft.input.lastIndexOf("\n", Math.max(0, draft.cursor - 1)) + 1;
      updateDraft(draft.input, start);
      return;
    }
    if (token.type === "end") {
      const breakIndex = draft.input.indexOf("\n", draft.cursor);
      updateDraft(draft.input, breakIndex === -1 ? draft.input.length : breakIndex);
      return;
    }
    if (token.type === "word_left") {
      updateDraft(draft.input, wordLeft(draft.input, draft.cursor));
      return;
    }
    if (token.type === "word_right") {
      updateDraft(draft.input, wordRight(draft.input, draft.cursor));
      return;
    }
    if (token.type === "kill_end") {
      const killed = killToEnd(draft.input, draft.cursor);
      updateDraft(killed.input, killed.cursor);
      return;
    }
    if (token.type === "kill_start") {
      const killed = killToStart(draft.input, draft.cursor);
      updateDraft(killed.input, killed.cursor);
      return;
    }
    if (token.type === "delete_word") {
      const removed = deleteWordBack(draft.input, draft.cursor);
      if (removed) updateDraft(removed.input, removed.cursor);
      return;
    }
    if (token.type === "backspace" || token.type === "delete") {
      const removed = backspace(draft.input, draft.cursor);
      if (removed) updateDraft(removed.input, removed.cursor);
      return;
    }
    if (token.type !== "text") return;
    // Palette filtering stays single-line; message input keeps pasted newlines.
    const clean = current.paletteOpen || paletteIntentRef.current
      ? token.value.replace(/[\r\n]+/g, " ")
      : token.value;
    const inserted = insertText(draft.input, draft.cursor, clean);
    updateDraft(inserted.input, inserted.cursor);
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
  const color = props.questionActive || props.approvalActive ? TUI_THEME.progress : props.running ? TUI_THEME.progress : props.paletteOpen ? TUI_THEME.active : TUI_THEME.ready;
  const hint = props.inputMode === "model-url"
    ? "https://api.example.com/v1"
    : props.inputMode === "model-key"
      ? "输入 API Key"
      : props.inputMode === "model-fetching"
        ? "正在获取模型列表"
        : props.approvalActive
          ? "输入 1-4 选择"
          : props.questionActive
            ? "输入序号或答案"
            : props.paletteOpen
              ? "输入筛选"
              : props.running
                ? "排队发送消息"
                : "输入消息，Alt+Enter 换行";
  const columns = stdout.columns || 80;
  const compact = columns < 64;
  const wizardInput = props.inputMode && props.inputMode !== "message";
  const vimTag = props.vimMode && !wizardInput && !props.paletteOpen
    ? (vimIndicator === "insert" ? "INSERT" : "NORMAL")
    : null;
  const leftHint = (props.paletteOpen
    ? "筛选  ·  ↑↓ 选择  Enter 确认"
    : props.approvalActive
      ? "输入 1-4 选择"
      : wizardInput
        ? "模型服务配置"
        : props.questionActive
          ? "Enter 提交"
          : "/ 命令  @ 引用  Alt+Enter 换行");
  const leftWithVim = vimTag ? `${vimTag} ｜ ${leftHint}` : leftHint;
  const rightHint = props.paletteOpen
    ? "Esc 关闭"
    : props.scrollback
      ? "PgUp/PgDn 翻页  Ctrl+O 返回"
      : wizardInput
        ? (props.inputMode === "model-fetching" ? "Esc 取消" : "Enter 下一步   Esc 取消")
        : props.approvalActive
          ? "Enter 确认   Ctrl+C 取消本轮"
          : props.questionActive
            ? "Ctrl+C 取消"
            : props.running
              ? "Enter 排队   Ctrl+C 中止"
              : "Enter 发送   Ctrl+C 退出";
  const nativeCursor = props.nativeCursor;
  const lines = renderLines(displayInput, props.cursor);

  const renderLine = (line: { text: string; cursorOffset: number | null }, index: number) => {
    const key = `line:${index}`;
    if (line.cursorOffset === null) {
      return <Text key={key} color={TUI_THEME.text}>{line.text || " "}</Text>;
    }
    const before = line.text.slice(0, line.cursorOffset);
    const at = line.text.slice(line.cursorOffset, line.cursorOffset + 1);
    const after = line.text.slice(line.cursorOffset + 1);
    const trailing = !displayInput && index === lines.length - 1 ? <Text color={TUI_THEME.muted}>{hint}</Text> : null;
    if (nativeCursor) {
      return (
        <Text key={key} color={TUI_THEME.text}>
          {before}{CURSOR_ANCHOR}{at || " "}{after}{trailing}
        </Text>
      );
    }
    return (
      <Text key={key}>
        <Text color={TUI_THEME.text}>{before}</Text>
        <Text inverse>{at || " "}</Text>
        <Text color={TUI_THEME.text}>{after}</Text>
        {trailing}
      </Text>
    );
  };

  const glyph = props.approvalActive ? "⚠ " : wizardInput ? "◆ " : props.questionActive ? "? " : props.running ? "+ " : "› ";
  const [firstLine, ...restLines] = lines;

  return (
    <Box flexDirection="column">
      <Box
        width="100%"
        borderStyle="round"
        borderColor={color}
        paddingX={1}
      >
        <Box flexGrow={1} flexDirection="column">
          {props.paletteOpen ? (
            nativeCursor ? (
              <Text color={TUI_THEME.text}>⌕ {props.input.slice(0, props.cursor)}{CURSOR_ANCHOR}{props.input.slice(props.cursor)}{!props.input ? <Text color={TUI_THEME.muted}>{hint}</Text> : null}</Text>
            ) : (
              <Text color={props.input ? TUI_THEME.text : TUI_THEME.muted}>⌕ {props.input || hint}</Text>
            )
          ) : (
            <>
              <Box>
                <Text color={color}>{glyph}</Text>
                {firstLine ? renderLine(firstLine, 0) : null}
              </Box>
              {restLines.map((line, index) => renderLine(line, index + 1))}
            </>
          )}
        </Box>
      </Box>
      {compact ? (
        <Text color={TUI_THEME.muted}>  {leftWithVim}  ·  {rightHint}</Text>
      ) : (
        <Box paddingX={1} justifyContent="space-between">
          <Text color={TUI_THEME.muted}>{leftWithVim}</Text>
          <Text color={TUI_THEME.muted}>{rightHint}</Text>
        </Box>
      )}
    </Box>
  );
}
