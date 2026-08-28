import stringWidth from "string-width";

export const CURSOR_ANCHOR = "\u001b]1337;agent-tui-cursor\u0007";

const CURSOR_HIDE = "\u001b[?25l";
const CURSOR_SHOW = "\u001b[?25h";
const cursorColumn = (column: number) => `\u001b[${column + 1}G`;
const cursorDown = (rows: number) => rows > 0 ? `\u001b[${rows}B` : "";
const cursorUp = (rows: number) => rows > 0 ? `\u001b[${rows}A` : "";

export interface CursorAwareOutput {
  stdout: NodeJS.WriteStream;
  restore(): void;
}

export function createCursorAwareOutput(stream: NodeJS.WriteStream): CursorAwareOutput {
  let parkedRowsBelow = 0;
  let parked = false;

  const restoreBottom = () => {
    if (!parked) return "";
    parked = false;
    return cursorDown(parkedRowsBelow) + cursorColumn(0);
  };

  const write = (chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
    const value = Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    if (value === CURSOR_HIDE && parked) return true;

    const anchorIndex = value.indexOf(CURSOR_ANCHOR);
    let output = CURSOR_HIDE + restoreBottom();

    if (value === CURSOR_SHOW) {
      output += CURSOR_SHOW;
      return (stream.write as (...args: unknown[]) => boolean)(output, encodingOrCallback, callback);
    }

    if (anchorIndex < 0) {
      output += value;
    } else {
      const before = value.slice(0, anchorIndex);
      const after = value.slice(anchorIndex + CURSOR_ANCHOR.length);
      const currentLine = before.slice(before.lastIndexOf("\n") + 1);
      parkedRowsBelow = (after.match(/\n/g) ?? []).length;
      output += before + after;
      output += cursorUp(parkedRowsBelow) + cursorColumn(stringWidth(currentLine)) + CURSOR_SHOW;
      parked = true;
    }

    return (stream.write as (...args: unknown[]) => boolean)(output, encodingOrCallback, callback);
  };

  const stdout = new Proxy(stream, {
    get(target, property) {
      if (property === "write") return write;
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    stdout,
    restore() {
      (stream.write as (chunk: string) => boolean)(CURSOR_HIDE + restoreBottom() + CURSOR_SHOW);
    },
  };
}
