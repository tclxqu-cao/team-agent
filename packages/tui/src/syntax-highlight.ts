import { TUI_THEME } from "./theme.js";

export interface CodeSegment {
  text: string;
  color?: string;
}

interface LanguageProfile {
  lineComment?: string[];
  blockComment?: [string, string];
  strings: string[];
  keywords: Set<string>;
  /** C-family vs hash-style number of extras kept minimal on purpose. */
  hashComments?: boolean;
}

const C_LIKE_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const", "continue",
  "debugger", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "from", "function", "get", "if", "implements", "import", "in", "instanceof", "interface",
  "let", "new", "null", "of", "private", "protected", "public", "readonly", "return", "satisfies",
  "set", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof", "undefined",
  "var", "void", "while", "yield", "fn", "let", "mut", "pub", "struct", "impl", "match", "use",
  "package", "func", "defer", "go", "chan", "select", "namespace", "template", "using", "virtual",
]);

const PYTHON_KEYWORDS = new Set([
  "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif",
  "else", "except", "False", "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "None", "nonlocal", "not", "or", "pass", "raise", "return", "True", "try", "while",
  "with", "yield", "self", "print",
]);

const SHELL_KEYWORDS = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac",
  "function", "return", "export", "local", "source", "echo", "cd", "exit", "set", "unset", "sudo",
  "git", "npm", "pnpm", "bun", "yarn", "node", "brew", "mkdir", "rm", "cp", "mv", "cat", "grep",
]);

const PROFILES: Record<string, LanguageProfile> = {
  clike: { lineComment: ["//"], blockComment: ["/*", "*/"], strings: ["\"", "'", "`"], keywords: C_LIKE_KEYWORDS },
  python: { lineComment: ["#"], blockComment: ["\"\"\"", "\"\"\""], strings: ["\"", "'"], keywords: PYTHON_KEYWORDS },
  shell: { lineComment: ["#"], strings: ["\"", "'"], keywords: SHELL_KEYWORDS },
  json: { strings: ["\""], keywords: new Set(["true", "false", "null"]) },
};

function profileFor(lang: string | undefined): LanguageProfile {
  const normalized = (lang ?? "").toLowerCase();
  if (["py", "python", "python3"].includes(normalized)) return PROFILES.python;
  if (["sh", "bash", "zsh", "shell", "console"].includes(normalized)) return PROFILES.shell;
  if (["json", "jsonc", "json5"].includes(normalized)) return PROFILES.json;
  return PROFILES.clike;
}

const KEYWORD_COLOR = TUI_THEME.spark;
const STRING_COLOR = TUI_THEME.user;
const COMMENT_COLOR = TUI_THEME.muted;
const NUMBER_COLOR = TUI_THEME.progress;
const MAX_HIGHLIGHT_CHARS = 20_000;

/**
 * Lightweight dependency-free tokenizer: strings, comments, numbers, keywords.
 * Good-enough coloring for a TUI transcript; deliberately not a full parser.
 */
export function highlightCode(code: string, lang?: string): CodeSegment[] {
  if (code.length > MAX_HIGHLIGHT_CHARS) return [{ text: code }];
  const profile = profileFor(lang);
  const segments: CodeSegment[] = [];
  let plain = "";
  const flush = () => {
    if (plain) {
      segments.push(...highlightKeywords(plain, profile));
      plain = "";
    }
  };

  let index = 0;
  while (index < code.length) {
    const rest = code.slice(index);
    const lineComment = profile.lineComment?.map((token) => ({ token, kind: "comment" as const }))
      .find(({ token }) => rest.startsWith(token));
    const blockComment = profile.blockComment && rest.startsWith(profile.blockComment[0])
      ? { kind: "comment" as const }
      : null;
    const stringToken = profile.strings.find((token) => rest.startsWith(token));

    if (lineComment) {
      flush();
      const end = rest.indexOf("\n");
      const token = end === -1 ? rest : rest.slice(0, end);
      segments.push({ text: token, color: COMMENT_COLOR });
      index += token.length;
      continue;
    }
    if (blockComment) {
      flush();
      const close = rest.indexOf(profile.blockComment![1], profile.blockComment![0].length);
      const token = close === -1 ? rest : rest.slice(0, close + profile.blockComment![1].length);
      segments.push({ text: token, color: COMMENT_COLOR });
      index += token.length;
      continue;
    }
    if (stringToken) {
      flush();
      const token = readString(rest, stringToken);
      segments.push({ text: token, color: STRING_COLOR });
      index += token.length;
      continue;
    }
    plain += rest[0];
    index += 1;
  }
  flush();
  return segments;
}

function readString(rest: string, open: string): string {
  let index = open.length;
  while (index < rest.length) {
    if (rest[index] === "\\") {
      index += 2;
      continue;
    }
    if (rest.startsWith(open, index)) {
      return rest.slice(0, index + open.length);
    }
    if (rest[index] === "\n" && open !== "`") {
      // Unterminated single-line string — stop at newline.
      return rest.slice(0, index);
    }
    index += 1;
  }
  return rest;
}

function highlightKeywords(text: string, profile: LanguageProfile): CodeSegment[] {
  const segments: CodeSegment[] = [];
  const pattern = /(\d+(?:\.\d+)?|\b[A-Za-z_][A-Za-z0-9_]*\b)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ text: text.slice(last, start) });
    const word = match[0];
    if (profile.keywords.has(word)) {
      segments.push({ text: word, color: KEYWORD_COLOR });
    } else if (/^\d/.test(word)) {
      segments.push({ text: word, color: NUMBER_COLOR });
    } else {
      segments.push({ text: word });
    }
    last = start + word.length;
  }
  if (last < text.length) segments.push({ text: text.slice(last) });
  return segments;
}

/** Merge adjacent same-color segments so Ink has fewer Text nodes to render. */
export function mergeSegments(segments: CodeSegment[]): CodeSegment[] {
  const merged: CodeSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && previous.color === segment.color) previous.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}
