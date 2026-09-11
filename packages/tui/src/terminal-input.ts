export type TerminalInputToken =
  | { type: "text"; value: string }
  | { type: "up" | "down" | "left" | "right" | "enter" | "escape" | "backspace" | "delete" | "ctrl_c" | "tab" | "pageup" | "pagedown" | "ctrl_o" }
  | { type: "home" | "end" | "kill_end" | "kill_start" | "delete_word" | "word_left" | "word_right" };

export interface ParsedTerminalInput {
  tokens: TerminalInputToken[];
  remainder: string;
}

const CSI_FINAL = /^\u001b\[([0-9;:?]*)([A-Za-z~])/;

function csiToken(parameters: string, final: string): TerminalInputToken | null {
  const fields = parameters.split(";");
  const eventType = fields[1]?.split(":")[1];
  if (eventType === "3") return null;

  if (final === "A") return { type: "up" };
  if (final === "B") return { type: "down" };
  if (final === "C") return { type: "right" };
  if (final === "D") return { type: "left" };

  const code = Number.parseInt(fields[0] ?? "", 10);
  if (final === "~") {
    if (code === 3) return { type: "delete" };
    if (code === 5) return { type: "pageup" };
    if (code === 6) return { type: "pagedown" };
    if (code === 27) return { type: "escape" };
    return null;
  }
  if (final !== "u") return null;

  if (code === 13) return { type: "enter" };
  if (code === 27) return { type: "escape" };
  if (code === 9) return { type: "tab" };
  if (code === 127) return { type: "backspace" };
  if (code === 57349) return { type: "delete" };
  if (code === 57350) return { type: "left" };
  if (code === 57351) return { type: "right" };
  if (code === 57352) return { type: "up" };
  if (code === 57353) return { type: "down" };
  return null;
}

export function parseTerminalInput(input: string, flushEscape = false): ParsedTerminalInput {
  const tokens: TerminalInputToken[] = [];
  const pastedOrBatched = input.length > 1;
  let index = 0;

  while (index < input.length) {
    const current = input[index];
    if (current === "\u001b") {
      const rest = input.slice(index);
      const csi = CSI_FINAL.exec(rest);
      if (csi) {
        const token = csiToken(csi[1] ?? "", csi[2] ?? "");
        if (token) tokens.push(token);
        index += csi[0].length;
        continue;
      }

      const ss3 = /^\u001bO([ABCD])/.exec(rest);
      if (ss3) {
        tokens.push({ type: ss3[1] === "A" ? "up" : ss3[1] === "B" ? "down" : ss3[1] === "C" ? "right" : "left" });
        index += ss3[0].length;
        continue;
      }

      // Alt+Enter arrives as ESC followed by CR/LF; treat it as a hard newline.
      if (rest[1] === "\r" || rest[1] === "\n") {
        tokens.push({ type: "text", value: "\n" });
        index += 2;
        continue;
      }

      // Alt+B / Alt+F move by word (Emacs-style).
      if (rest[1] === "b" || rest[1] === "f") {
        tokens.push({ type: rest[1] === "b" ? "word_left" : "word_right" });
        index += 2;
        continue;
      }

      const incomplete = rest === "\u001b" || /^\u001b(?:\[[0-9;:?]*|O)$/.test(rest);
      if (incomplete && !flushEscape) return { tokens, remainder: rest };
      tokens.push({ type: "escape" });
      index += 1;
      continue;
    }

    if (current === "\u0003") {
      tokens.push({ type: "ctrl_c" });
      index += 1;
      continue;
    }
    if (current === "\u000f") {
      tokens.push({ type: "ctrl_o" });
      index += 1;
      continue;
    }
    if (current === "\u0001") {
      tokens.push({ type: "home" });
      index += 1;
      continue;
    }
    if (current === "\u0005") {
      tokens.push({ type: "end" });
      index += 1;
      continue;
    }
    if (current === "\u000b") {
      tokens.push({ type: "kill_end" });
      index += 1;
      continue;
    }
    if (current === "\u0015") {
      tokens.push({ type: "kill_start" });
      index += 1;
      continue;
    }
    if (current === "\u0017") {
      tokens.push({ type: "delete_word" });
      index += 1;
      continue;
    }
    if (current === "\r" || current === "\n") {
      // A newline inside a multi-char chunk is a paste: keep it as a literal
      // line break instead of collapsing it into a submit or a space.
      tokens.push(pastedOrBatched ? { type: "text", value: "\n" } : { type: "enter" });
      index += 1;
      continue;
    }
    if (current === "\u007f" || current === "\b") {
      tokens.push({ type: "backspace" });
      index += 1;
      continue;
    }
    if (current === "\t") {
      tokens.push({ type: "tab" });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < input.length && !/[\u0001\u0003\u0005\u0008\u0009\u000a\u000b\u000f\u000d\u0015\u0017\u001b\u007f]/.test(input[end] ?? "")) end += 1;
    tokens.push({ type: "text", value: input.slice(index, end) });
    index = end;
  }

  return { tokens, remainder: "" };
}
