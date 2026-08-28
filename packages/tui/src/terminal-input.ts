export type TerminalInputToken =
  | { type: "text"; value: string }
  | { type: "up" | "down" | "left" | "right" | "enter" | "escape" | "backspace" | "delete" | "ctrl_c" | "tab" };

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
    if (current === "\r" || current === "\n") {
      tokens.push(pastedOrBatched ? { type: "text", value: " " } : { type: "enter" });
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
    while (end < input.length && !/[\u0003\u0008\u0009\u000a\u000d\u001b\u007f]/.test(input[end] ?? "")) end += 1;
    tokens.push({ type: "text", value: input.slice(index, end) });
    index = end;
  }

  return { tokens, remainder: "" };
}
