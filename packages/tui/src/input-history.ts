import { promises as fsp } from "node:fs";
import path from "node:path";

const MAX_HISTORY_ENTRIES = 500;

/** Load the persisted composer input history, oldest first. */
export async function loadInputHistory(filePath: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const entries: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string" || !value.trim() || seen.has(value)) continue;
      seen.add(value);
      entries.push(value);
    }
    return entries.slice(-MAX_HISTORY_ENTRIES);
  } catch {
    return [];
  }
}

/** Append an entry to the persisted history, deduplicating consecutive repeats. */
export async function appendInputHistory(filePath: string, previous: string[], entry: string): Promise<string[]> {
  const trimmed = entry.trim();
  if (!trimmed) return previous;
  if (previous[previous.length - 1] === trimmed) return previous;
  const next = [...previous, trimmed].slice(-MAX_HISTORY_ENTRIES);
  try {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    await fsp.writeFile(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fsp.rename(temporary, filePath);
  } catch {
    return previous;
  }
  return next;
}
