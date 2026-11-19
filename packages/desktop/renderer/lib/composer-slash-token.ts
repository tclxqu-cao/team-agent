export interface ComposerSlashToken {
  start: number;
  end: number;
  query: string;
}

/** Find the slash command being edited at the caret, without treating paths as commands. */
export function readComposerSlashToken(value: string, caret: number): ComposerSlashToken | null {
  const before = value.slice(0, caret).match(/(?:^|\s)\/([-\w\u4e00-\u9fff]*)$/);
  if (!before) return null;

  const query = before[1];
  const after = value.slice(caret).match(/^[-\w\u4e00-\u9fff]*(?=\s|$)/);
  if (!after || (!query && after[0])) return null;

  return { start: caret - query.length - 1, end: caret + after[0].length, query };
}

export function completeComposerSlashToken(value: string, token: ComposerSlashToken, name: string) {
  const suffix = value.slice(token.end);
  const prefix = value.slice(0, token.start) + "/" + name;
  return { value: prefix + (suffix || " "), caret: prefix.length + 1 };
}
