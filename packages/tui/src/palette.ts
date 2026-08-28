export type PaletteKind =
  | "command"
  | "skill"
  | "project"
  | "folder"
  | "file"
  | "model"
  | "session"
  | "action";

export interface PaletteItem {
  id: string;
  kind: PaletteKind;
  label: string;
  description: string;
  value: string;
  disabled?: boolean;
  metadata?: Record<string, string>;
}

export interface ActiveTrigger {
  type: "slash" | "mention";
  start: number;
  query: string;
}

export function getActiveTrigger(buffer: string, cursor: number): ActiveTrigger | null {
  const before = buffer.slice(0, Math.max(0, Math.min(cursor, buffer.length)));
  if (before.startsWith("/") && !/\s/.test(before)) {
    return { type: "slash", start: 0, query: before.slice(1) };
  }

  const mention = /(^|\s)@(?:"([^"]*)|([^\s]*))$/.exec(before);
  if (!mention) return null;
  const prefixLength = mention[1]?.length ?? 0;
  return {
    type: "mention",
    start: before.length - mention[0].length + prefixLength,
    query: mention[2] ?? mention[3] ?? "",
  };
}

function score(item: PaletteItem, query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const label = item.label.toLowerCase();
  const value = item.value.toLowerCase();
  const description = item.description.toLowerCase();
  const searchText = item.metadata?.searchText?.toLowerCase() ?? "";
  if (label === needle || value === needle) return 0;
  if (label.startsWith(needle) || value.startsWith(needle)) return 1;
  if (label.includes(needle) || value.includes(needle)) return 2;
  if (description.includes(needle)) return 3;
  if (searchText.includes(needle)) return 4;
  return Number.POSITIVE_INFINITY;
}

export function filterPaletteItems(
  items: readonly PaletteItem[],
  query: string,
  limit = 12,
): PaletteItem[] {
  return items
    .map((item, index) => ({ item, index, score: score(item, query) }))
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => a.score - b.score || Number(a.item.disabled) - Number(b.item.disabled) || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function replaceTrigger(
  buffer: string,
  cursor: number,
  trigger: ActiveTrigger,
  replacement: string,
): { buffer: string; cursor: number } {
  const next = buffer.slice(0, trigger.start) + replacement + buffer.slice(cursor);
  return { buffer: next, cursor: trigger.start + replacement.length };
}
