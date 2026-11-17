import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Read-only SQLite access following the WorkBuddy catalog precedent: lazy
 * node:sqlite load, short busy timeout, always closed. Never opens for write. */
export function readRows(path: string, sql: string, ...params: unknown[]): Record<string, unknown>[] {
  const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 100");
    return database.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

export function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function timeMs(value: unknown): number | undefined {
  const n = num(value);
  if (n !== undefined) {
    if (n >= 1e12) return n;
    if (n >= 1e9) return n * 1000;
    return undefined;
  }
  const parsed = Date.parse(str(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}