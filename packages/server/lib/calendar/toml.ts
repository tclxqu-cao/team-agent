// Minimal TOML subset reader for Codex automation.toml files: bare keys with
// basic/literal strings (incl. multi-line), numbers, booleans, string arrays
// and shallow inline tables. Unknown constructs are skipped, never thrown.

export function parseTomlSubset(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#") || line.startsWith("[")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
    let raw = line.slice(eq + 1).trim();
    if (raw.startsWith('"""')) {
      let body = raw.slice(3);
      while (!body.includes('"""') && i + 1 < lines.length) body += `\n${lines[++i]}`;
      const close = body.indexOf('"""');
      result[key] = unescapeBasic(close >= 0 ? body.slice(0, close) : body);
      continue;
    }
    if (raw.startsWith("[") && !bracketsBalanced(raw)) {
      while (!bracketsBalanced(raw) && i + 1 < lines.length) raw += ` ${lines[++i]!.trim()}`;
    }
    if (raw.startsWith("{") && !bracesBalanced(raw)) {
      while (!bracesBalanced(raw) && i + 1 < lines.length) raw += ` ${lines[++i]!.trim()}`;
    }
    const value = parseValue(raw);
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function bracketsBalanced(raw: string): boolean {
  let depth = 0;
  for (const ch of raw) {
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
  }
  return depth <= 0;
}

function bracesBalanced(raw: string): boolean {
  let depth = 0;
  for (const ch of raw) {
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
  }
  return depth <= 0;
}

function parseValue(raw: string): unknown {
  const value = stripComment(raw).trim();
  if (!value) return undefined;
  if (value.startsWith('"')) {
    const end = findStringEnd(value, '"');
    return end > 0 ? unescapeBasic(value.slice(1, end)) : undefined;
  }
  if (value.startsWith("'")) {
    const end = value.indexOf("'", 1);
    return end > 0 ? value.slice(1, end) : undefined;
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[")) {
    const inner = value.slice(1, value.lastIndexOf("]"));
    return splitTopLevel(inner, ",").map(part => parseValue(part.trim())).filter(v => v !== undefined);
  }
  if (value.startsWith("{")) {
    const inner = value.slice(1, value.lastIndexOf("}"));
    const record: Record<string, unknown> = {};
    for (const pair of splitTopLevel(inner, ",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const k = pair.slice(0, eq).trim();
      const v = parseValue(pair.slice(eq + 1).trim());
      if (v !== undefined) record[k] = v;
    }
    return record;
  }
  if (/^[+-]?\d+$/.test(value)) return parseInt(value, 10);
  if (/^[+-]?\d*\.\d+$/.test(value)) return parseFloat(value);
  return undefined;
}

function stripComment(raw: string): string {
  let inString: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'") inString = ch;
    else if (ch === "#") return raw.slice(0, i);
  }
  return raw;
}

function findStringEnd(value: string, quote: string): number {
  for (let i = 1; i < value.length; i++) {
    if (value[i] === "\\") i++;
    else if (value[i] === quote) return i;
  }
  return -1;
}

function splitTopLevel(inner: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (inString) {
      current += ch;
      if (ch === "\\") { current += inner[++i] ?? ""; }
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = ch; current += ch; continue; }
    if (ch === "[" || ch === "{") depth++;
    if (ch === "]" || ch === "}") depth--;
    if (ch === separator && depth === 0) { parts.push(current); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function unescapeBasic(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, esc: string) => {
    if (esc.startsWith("u") || esc.startsWith("U")) return String.fromCodePoint(parseInt(esc.slice(1), 16));
    switch (esc) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case '"': return '"';
      case "\\": return "\\";
      default: return esc;
    }
  });
}