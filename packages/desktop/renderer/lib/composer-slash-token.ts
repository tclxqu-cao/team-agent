export interface ComposerSlashToken {
  start: number;
  end: number;
  query: string;
}

/** Find the slash command being edited at the caret, without treating paths as commands. */
export function readComposerSlashToken(value: string, caret: number, prefix: "/" | "$" = "/"): ComposerSlashToken | null {
  const before = value.slice(0, caret).match(prefix === "/"
    ? /(?:^|\s)\/([-\p{L}\p{N}_]*)$/u
    : /(?:^|\s)\$([-\p{L}\p{N}_]*)$/u);
  if (!before) return null;

  const query = before[1];
  const after = value.slice(caret).match(/^[-\p{L}\p{N}_]*(?=\s|$)/u);
  if (!after || (!query && after[0])) return null;

  return { start: caret - query.length - 1, end: caret + after[0].length, query };
}

export function completeComposerSlashToken(value: string, token: ComposerSlashToken, name: string) {
  const suffix = value.slice(token.end);
  const prefix = value.slice(0, token.start + 1) + name;
  return { value: prefix + (suffix || " "), caret: prefix.length + 1 };
}
