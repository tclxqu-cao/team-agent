export type MarkdownLinkToken =
  | { type: "text"; value: string }
  | { type: "link"; label: string; href: string }
  | { type: "artifact"; label: string; path: string; line?: number; raw: string };

export type RichInlineToken = MarkdownLinkToken | { type: "code"; value: string };

const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|[ \t]*\/[^)\n]+)\)/gi;
const INLINE_CODE_PATTERN = /`([^`\n]+)`/g;
const CODEX_FILE_CITATION_PATTERN = /:codex-file-citation\{([^}\n]*)\}/g;
const CODEX_FILE_CITATION_ATTRIBUTE_PATTERN = /([A-Za-z][\w-]*)="([^"\n]*)"/g;

type InlineLinkMatch = {
  kind: "markdown" | "citation" | "code";
  match: RegExpMatchArray;
};

function parseArtifactTarget(target: string): { path: string; line?: number } | null {
  if (!target.startsWith("/") || target.includes("?") || target.includes("#") || target.includes("\0")) {
    return null;
  }
  const lineMatch = target.match(/^(\/.*):([1-9]\d*)$/);
  if (!lineMatch) return { path: target };
  return { path: lineMatch[1], line: Number(lineMatch[2]) };
}

function parseCodexFileCitation(attributesSource: string): { path: string; label: string } | null {
  const attributes: Record<string, string> = {};
  for (const match of attributesSource.matchAll(CODEX_FILE_CITATION_ATTRIBUTE_PATTERN)) {
    const name = match[1];
    if ((name !== "path" && name !== "purpose") || attributes[name] !== undefined) return null;
    attributes[name] = match[2];
  }
  if (attributesSource.replace(CODEX_FILE_CITATION_ATTRIBUTE_PATTERN, "").trim()) return null;
  const artifact = parseArtifactTarget(attributes.path ?? "");
  if (!artifact || artifact.line !== undefined) return null;
  const label = artifact.path.slice(artifact.path.lastIndexOf("/") + 1) || artifact.path;
  return { path: artifact.path, label };
}

function parseInlineTokens(text: string, includeCode: false): MarkdownLinkToken[];
function parseInlineTokens(text: string, includeCode: true): RichInlineToken[];
function parseInlineTokens(text: string, includeCode: boolean): RichInlineToken[] {
  const tokens: RichInlineToken[] = [];
  let cursor = 0;
  const matches: InlineLinkMatch[] = [
    ...[...text.matchAll(MARKDOWN_LINK_PATTERN)].map((match) => ({ kind: "markdown" as const, match })),
    ...[...text.matchAll(CODEX_FILE_CITATION_PATTERN)].map((match) => ({ kind: "citation" as const, match })),
    ...(includeCode
      ? [...text.matchAll(INLINE_CODE_PATTERN)].map((match) => ({ kind: "code" as const, match }))
      : []),
  ].sort((left, right) => (left.match.index ?? 0) - (right.match.index ?? 0));

  for (const candidate of matches) {
    const { match } = candidate;
    const index = match.index ?? 0;
    if (index < cursor) continue;
    if (index > cursor) {
      tokens.push({ type: "text", value: text.slice(cursor, index) });
    }
    if (candidate.kind === "code") {
      tokens.push({ type: "code", value: match[1] });
      cursor = index + match[0].length;
      continue;
    }
    if (candidate.kind === "citation") {
      const artifact = parseCodexFileCitation(match[1]);
      tokens.push(artifact ? {
        type: "artifact",
        label: artifact.label,
        path: artifact.path,
        raw: match[0],
      } : { type: "text", value: match[0] });
      cursor = index + match[0].length;
      continue;
    }
    const target = match[2];
    if (/^https?:\/\//i.test(target)) {
      tokens.push({ type: "link", label: match[1], href: target });
    } else {
      const artifact = parseArtifactTarget(target.replace(/^[ \t]+/, ""));
      if (artifact) {
        tokens.push({
          type: "artifact",
          label: match[1],
          path: artifact.path,
          ...(artifact.line ? { line: artifact.line } : {}),
          raw: match[0],
        });
      } else {
        tokens.push({ type: "text", value: match[0] });
      }
    }
    cursor = index + match[0].length;
  }

  if (cursor < text.length) {
    tokens.push({ type: "text", value: text.slice(cursor) });
  }

  return tokens.length > 0 ? tokens : [{ type: "text", value: text }];
}

export function parseMarkdownLinks(text: string): MarkdownLinkToken[] {
  return parseInlineTokens(text, false);
}

export function parseRichInlineTokens(text: string): RichInlineToken[] {
  return parseInlineTokens(text, true);
}
