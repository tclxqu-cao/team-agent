/** Pure multi-line single-line-buffer editing helpers shared by the Composer. */

export interface EditResult {
  input: string;
  cursor: number;
}

function lineBounds(input: string, cursor: number): { start: number; end: number } {
  const clamped = Math.max(0, Math.min(cursor, input.length));
  const start = input.lastIndexOf("\n", clamped - 1) + 1;
  const nextBreak = input.indexOf("\n", clamped);
  return { start, end: nextBreak === -1 ? input.length : nextBreak };
}

/** Index of the first character of the visual line under the caret. */
export function lineStartOf(input: string, cursor: number): number {
  return lineBounds(input, cursor).start;
}

/** Index just past the last character of the visual line under the caret. */
export function lineEndOf(input: string, cursor: number): number {
  return lineBounds(input, cursor).end;
}

function column(input: string, cursor: number): number {
  return cursor - lineBounds(input, cursor).start;
}

export function moveLeft(input: string, cursor: number): number {
  if (cursor <= 0) return 0;
  if (input[cursor - 1] === "\n") return cursor - 1;
  return cursor - 1;
}

export function moveRight(input: string, cursor: number): number {
  if (cursor >= input.length) return input.length;
  return cursor + 1;
}

/** Move the cursor one visual line up; returns null on the first line. */
export function moveUp(input: string, cursor: number): number | null {
  const { start } = lineBounds(input, cursor);
  if (start === 0) return null;
  const previousEnd = start - 1;
  const previousStart = input.lastIndexOf("\n", previousEnd - 1) + 1;
  return Math.min(previousStart + column(input, cursor), previousEnd);
}

/** Move the cursor one visual line down; returns null on the last line. */
export function moveDown(input: string, cursor: number): number | null {
  const { end } = lineBounds(input, cursor);
  if (end >= input.length) return null;
  const nextStart = end + 1;
  const nextEnd = input.indexOf("\n", nextStart) === -1 ? input.length : input.indexOf("\n", nextStart);
  return Math.min(nextStart + column(input, cursor), nextEnd);
}

/** True when the caret sits on the first visual line. */
export function onFirstLine(input: string, cursor: number): boolean {
  return lineBounds(input, cursor).start === 0;
}

/** True when the caret sits on the last visual line. */
export function onLastLine(input: string, cursor: number): boolean {
  return lineBounds(input, cursor).end >= input.length;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && !/\s/.test(ch);
}

/** Beginning of the word before the caret (skips whitespace first). */
export function wordLeft(input: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, input.length));
  while (index > 0 && !isWordChar(input[index - 1])) index -= 1;
  while (index > 0 && isWordChar(input[index - 1])) index -= 1;
  return index;
}

/** End of the word after the caret (skips whitespace first). */
export function wordRight(input: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, input.length));
  while (index < input.length && !isWordChar(input[index])) index += 1;
  while (index < input.length && isWordChar(input[index])) index += 1;
  return index;
}

/** Delete the word before the caret (Ctrl+W); null when nothing to delete. */
export function deleteWordBack(input: string, cursor: number): EditResult | null {
  const target = wordLeft(input, cursor);
  if (target === cursor) return null;
  return { input: input.slice(0, target) + input.slice(cursor), cursor: target };
}

/** Kill from the caret to the end of the current line (Ctrl+K). At line end removes the line break. */
export function killToEnd(input: string, cursor: number): EditResult {
  const { end } = lineBounds(input, cursor);
  if (cursor < end) return { input: input.slice(0, cursor) + input.slice(end), cursor };
  if (input[cursor] === "\n") return { input: input.slice(0, cursor) + input.slice(cursor + 1), cursor };
  return { input, cursor };
}

/** Kill from the start of the current line to the caret (Ctrl+U). */
export function killToStart(input: string, cursor: number): EditResult {
  const { start } = lineBounds(input, cursor);
  if (start === cursor) return { input, cursor };
  return { input: input.slice(0, start) + input.slice(cursor), cursor: start };
}

export function insertText(input: string, cursor: number, value: string): EditResult {
  return { input: input.slice(0, cursor) + value + input.slice(cursor), cursor: cursor + value.length };
}

/** Backspace across a newline joins the previous line; returns null when nothing to delete. */
export function backspace(input: string, cursor: number): EditResult | null {
  if (cursor <= 0) return null;
  return { input: input.slice(0, cursor - 1) + input.slice(cursor), cursor: cursor - 1 };
}

export interface RenderLine {
  text: string;
  cursorOffset: number | null;
}

/** Split the buffer into visual lines, tagging the line that holds the caret. */
export function renderLines(input: string, cursor: number): RenderLine[] {
  const clamped = Math.max(0, Math.min(cursor, input.length));
  const lines: RenderLine[] = [];
  let offset = 0;
  for (const text of input.split("\n")) {
    const start = offset;
    const end = offset + text.length;
    lines.push({ text, cursorOffset: clamped >= start && clamped <= end ? clamped - start : null });
    offset = end + 1;
  }
  return lines;
}
