import type { TerminalInputToken } from "./terminal-input.js";
import { lineEndOf, lineStartOf, moveDown, moveUp, wordLeft, wordRight } from "./text-editor.js";

export type VimMode = "normal" | "insert";

export interface VimBuffer {
  input: string;
  cursor: number;
}

export interface VimState {
  mode: VimMode;
  /** Operator pending: "", "d", "y", "g". */
  pending: string;
  register: string;
  linewise: boolean;
  undoStack: VimBuffer[];
}

export interface VimResult {
  state: VimState;
  buffer: VimBuffer;
  /** true = the key was consumed by vim and must not reach the composer. */
  consumed: boolean;
  /** true = the key was consumed but has no effect (unknown command). */
  bell: boolean;
}

const UNDO_LIMIT = 100;

export function initialVimState(): VimState {
  return { mode: "normal", pending: "", register: "", linewise: false, undoStack: [] };
}

function pushUndo(state: VimState, buffer: VimBuffer): VimState {
  return { ...state, undoStack: [...state.undoStack, { ...buffer }].slice(-UNDO_LIMIT) };
}

/** Delete the current line (including its newline) into the register, linewise. */
function deleteLine(buffer: VimBuffer): VimBuffer {
  const start = lineStartOf(buffer.input, buffer.cursor);
  const end = lineEndOf(buffer.input, buffer.cursor);
  const inclusive = buffer.input[end] === "\n" ? 1 : 0;
  const line = buffer.input.slice(start, end + inclusive) || "\n";
  const input = buffer.input.slice(0, start) + buffer.input.slice(end + inclusive);
  return { input, cursor: Math.min(start, Math.max(0, input.length - 1)) };
}

function yankLine(buffer: VimBuffer): string {
  const start = lineStartOf(buffer.input, buffer.cursor);
  const end = lineEndOf(buffer.input, buffer.cursor);
  const inclusive = buffer.input[end] === "\n" ? 1 : 0;
  return buffer.input.slice(start, end + inclusive);
}

function paste(buffer: VimBuffer, register: string, linewise: boolean, after: boolean): VimBuffer {
  if (!register) return buffer;
  if (linewise) {
    const start = lineStartOf(buffer.input, buffer.cursor);
    const end = lineEndOf(buffer.input, buffer.cursor);
    if (after) {
      const needsSeparator = buffer.input[end] !== "\n";
      const insertAt = needsSeparator ? end : end + 1;
      const line = register.endsWith("\n") ? register : register + "\n";
      return {
        input: buffer.input.slice(0, insertAt) + (needsSeparator ? "\n" : "") + line + buffer.input.slice(insertAt),
        cursor: insertAt + (needsSeparator ? 1 : 0),
      };
    }
    const line = register.endsWith("\n") ? register : register + "\n";
    return { input: buffer.input.slice(0, start) + line + buffer.input.slice(start), cursor: start };
  }
  const at = after ? Math.min(buffer.input.length, buffer.cursor + 1) : buffer.cursor;
  return { input: buffer.input.slice(0, at) + register + buffer.input.slice(at), cursor: at };
}

function endOfWord(input: string, cursor: number): number {
  let index = cursor;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  while (index < input.length - 1 && !/\s/.test(input[index + 1])) index += 1;
  return Math.min(input.length, index + (index < input.length ? 1 : 0));
}

/** Start of the next word (vim `w`): end of the current word, then whitespace. */
function nextWordStart(input: string, cursor: number): number {
  let index = cursor;
  while (index < input.length && !/\s/.test(input[index])) index += 1;
  while (index < input.length && /\s/.test(input[index])) index += 1;
  return index;
}

export function applyVimKey(state: VimState, buffer: VimBuffer, token: TerminalInputToken): VimResult {
  if (state.mode === "insert") {
    if (token.type === "escape") {
      return { state: { ...state, mode: "normal", pending: "" }, buffer, consumed: true, bell: false };
    }
    return { state, buffer, consumed: false, bell: false };
  }

  const finish = (next: VimState, nextBuffer: VimBuffer, bell = false): VimResult =>
    ({ state: next, buffer: nextBuffer, consumed: true, bell });

  // Operator + motion pairs: dd, dw, db, d$, yy, y$, gg.
  const single = token.type === "text" && token.value.length === 1 ? token.value : null;
  if (single && state.pending && token.type === "text") {
    const operator = state.pending;
    const cleared = { ...state, pending: "" };
    if (operator === "d" && (single === "d" || single === "w" || single === "b" || single === "$")) {
      const withUndoState = { ...pushUndo(state, buffer), pending: "" };
      if (single === "d") {
        return finish({ ...withUndoState, register: yankLine(buffer), linewise: true }, deleteLine(buffer));
      }
      if (single === "w" || single === "b" || single === "$") {
        const target = single === "w" ? nextWordStart(buffer.input, buffer.cursor)
          : single === "b" ? wordLeft(buffer.input, buffer.cursor)
            : lineEndOf(buffer.input, buffer.cursor);
        const [from, to] = single === "b" ? [target, buffer.cursor] : [buffer.cursor, target];
        return finish({ ...withUndoState, register: buffer.input.slice(from, to), linewise: false }, {
          input: buffer.input.slice(0, from) + buffer.input.slice(to),
          cursor: from,
        });
      }
    }
    if (operator === "y" && (single === "y" || single === "$")) {
      if (single === "y") {
        return finish({ ...cleared, register: yankLine(buffer), linewise: true }, buffer);
      }
      return finish({ ...cleared, register: buffer.input.slice(buffer.cursor, lineEndOf(buffer.input, buffer.cursor)), linewise: false }, buffer);
    }
    if (operator === "g" && single === "g") {
      return finish(cleared, { input: buffer.input, cursor: 0 });
    }
    // Unknown operator combination — clear pending, bell.
    return finish(cleared, buffer, true);
  }

  if (token.type === "escape") {
    return finish({ ...state, pending: "" }, buffer, true);
  }

  const earlySingle = token.type === "text" && token.value.length === 1 ? token.value : null;
  if (earlySingle === "/") {
    // Slash commands must stay reachable from NORMAL mode — map "/" to the
    // command palette by letting it fall through to the composer.
    return { state: { ...state, pending: "" }, buffer, consumed: false, bell: false };
  }
  if (token.type === "enter" || token.type === "tab") {
    // Enter keeps its submit semantics even in normal mode.
    return { state: { ...state, pending: "" }, buffer, consumed: false, bell: false };
  }
  if (token.type === "up") {
    const target = moveUp(buffer.input, buffer.cursor);
    return target === null ? finish(state, buffer, true) : finish(state, { input: buffer.input, cursor: target });
  }
  if (token.type === "down") {
    const target = moveDown(buffer.input, buffer.cursor);
    return target === null ? finish(state, buffer, true) : finish(state, { input: buffer.input, cursor: target });
  }
  if (token.type === "left" || (token.type === "backspace")) {
    const start = lineStartOf(buffer.input, buffer.cursor);
    return finish(state, { input: buffer.input, cursor: Math.max(start, buffer.cursor - 1) });
  }
  if (token.type === "right") {
    const end = lineEndOf(buffer.input, buffer.cursor);
    return finish(state, { input: buffer.input, cursor: Math.min(end, buffer.cursor + 1) });
  }
  if (token.type === "home") return finish(state, { input: buffer.input, cursor: lineStartOf(buffer.input, buffer.cursor) });
  if (token.type === "end") return finish(state, { input: buffer.input, cursor: lineEndOf(buffer.input, buffer.cursor) });
  if (token.type !== "text" || token.value.length !== 1) {
    // Paste or multi-char text in normal mode: ignore (bell) rather than misinterpret.
    return finish(state, buffer, true);
  }

  const key = token.value;

  switch (key) {
    case "h":
      return finish(state, { input: buffer.input, cursor: Math.max(lineStartOf(buffer.input, buffer.cursor), buffer.cursor - 1) });
    case "l":
      return finish(state, { input: buffer.input, cursor: Math.min(lineEndOf(buffer.input, buffer.cursor), buffer.cursor + 1) });
    case "0":
      return finish(state, { input: buffer.input, cursor: lineStartOf(buffer.input, buffer.cursor) });
    case "$":
      return finish(state, { input: buffer.input, cursor: lineEndOf(buffer.input, buffer.cursor) });
    case "w":
      return finish(state, { input: buffer.input, cursor: nextWordStart(buffer.input, buffer.cursor) });
    case "b":
      return finish(state, { input: buffer.input, cursor: wordLeft(buffer.input, buffer.cursor) });
    case "e":
      return finish(state, { input: buffer.input, cursor: Math.max(buffer.cursor, endOfWord(buffer.input, buffer.cursor) - 1) });
    case "G":
      return finish(state, { input: buffer.input, cursor: buffer.input.length });
    case "g":
      return finish({ ...state, pending: "g" }, buffer);
    case "d":
    case "y":
      return finish({ ...state, pending: key }, buffer);
    case "x": {
      if (buffer.cursor >= buffer.input.length || buffer.input[buffer.cursor] === "\n") {
        return finish(state, buffer, true);
      }
      const withUndoState = pushUndo(state, buffer);
      return finish(withUndoState, {
        input: buffer.input.slice(0, buffer.cursor) + buffer.input.slice(buffer.cursor + 1),
        cursor: buffer.cursor,
      });
    }
    case "D":
    case "C": {
      const withUndoState = pushUndo(state, buffer);
      const end = lineEndOf(buffer.input, buffer.cursor);
      const register = buffer.input.slice(buffer.cursor, end);
      return finish({
        ...withUndoState,
        register,
        linewise: false,
        mode: key === "C" ? "insert" : state.mode,
      }, {
        input: buffer.input.slice(0, buffer.cursor) + buffer.input.slice(end),
        cursor: buffer.cursor,
      });
    }
    case "u": {
      const previous = state.undoStack.at(-1);
      if (!previous) return finish(state, buffer, true);
      return finish({ ...state, undoStack: state.undoStack.slice(0, -1) }, { ...previous });
    }
    case "p":
    case "P": {
      if (!state.register) return finish(state, buffer, true);
      const withUndoState = pushUndo(state, buffer);
      return finish(withUndoState, paste(buffer, state.register, state.linewise, key === "p"));
    }
    case "i":
      return finish({ ...state, mode: "insert" }, buffer);
    case "a":
      return finish({ ...state, mode: "insert" }, { input: buffer.input, cursor: Math.min(lineEndOf(buffer.input, buffer.cursor), buffer.cursor + 1) });
    case "I":
      return finish({ ...state, mode: "insert" }, { input: buffer.input, cursor: lineStartOf(buffer.input, buffer.cursor) });
    case "A":
      return finish({ ...state, mode: "insert" }, { input: buffer.input, cursor: lineEndOf(buffer.input, buffer.cursor) });
    case "o":
    case "O": {
      const withUndoState = pushUndo(state, buffer);
      const start = lineStartOf(buffer.input, buffer.cursor);
      const end = lineEndOf(buffer.input, buffer.cursor);
      // "o" opens below (after the line's newline); "O" opens above the line.
      const insertAt = key === "o"
        ? (buffer.input[end] === "\n" ? end + 1 : end)
        : start;
      return finish({ ...withUndoState, mode: "insert" }, {
        input: buffer.input.slice(0, insertAt) + "\n" + buffer.input.slice(insertAt),
        cursor: insertAt,
      });
    }
    default:
      return finish(state, buffer, true);
  }
}
