export type MarkdownLinkToken =
  | { type: "text"; value: string }
  | { type: "link"; label: string; href: string }
  | { type: "artifact"; label: string; path: string; line?: number; raw: string };

const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^)\n]+)\)/gi;

function parseArtifactTarget(target: string): { path: string; line?: number } | null {
  if (!target.startsWith("/") || target.includes("?") || target.includes("#") || target.includes("\0")) {
    return null;
  }
  const lineMatch = target.match(/^(\/.*):([1-9]\d*)$/);
  if (!lineMatch) return { path: target };
  return { path: lineMatch[1], line: Number(lineMatch[2]) };
}

export function parseMarkdownLinks(text: string): MarkdownLinkToken[] {
  const tokens: MarkdownLinkToken[] = [];
  let cursor = 0;

  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      tokens.push({ type: "text", value: text.slice(cursor, index) });
    }
    const target = match[2];
    if (/^https?:\/\//i.test(target)) {
      tokens.push({ type: "link", label: match[1], href: target });
    } else {
      const artifact = parseArtifactTarget(target);
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
