export interface MemoryCitation {
  source: string;
  note: string;
}

/** Separate Codex metadata from prose without changing stored messages or code examples. */
export function extractMemoryCitations(text: string): { text: string; citations: MemoryCitation[] } {
  const opening = "<oai-mem-citation>";
  const closing = "</oai-mem-citation>";
  const citations: MemoryCitation[] = [];
  const lines = text.split("\n");
  const visible: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const marker = trimmed.match(/^(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      visible.push(line);
      continue;
    }
    if (!fence && trimmed.startsWith(opening)) {
      const block: string[] = [trimmed.slice(opening.length)];
      while (!block[block.length - 1].includes(closing) && i + 1 < lines.length) block.push(lines[++i]);
      const raw = block.join("\n");
      const end = raw.indexOf(closing);
      // In-flight metadata stays hidden until its closing tag arrives.
      if (end < 0) break;
      const entries = raw.slice(0, end).match(/<citation_entries>([\s\S]*?)<\/citation_entries>/)?.[1];
      for (const entry of entries?.split("\n") ?? []) {
        const match = entry.trim().match(/^(.+?):(\d+)(?:-(\d+))?\|note=\[(.*)\]$/);
        if (match) citations.push({ source: `${match[1]}:${match[2]}${match[3] ? `–${match[3]}` : ""}`, note: match[4] });
      }
      const tail = raw.slice(end + closing.length);
      if (tail) visible.push(tail);
      continue;
    }
    if (!fence && i === lines.length - 1 && trimmed.length >= 2 && opening.startsWith(trimmed)) break;
    visible.push(line);
  }
  return { text: visible.join("\n").trimEnd(), citations };
}
