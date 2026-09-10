import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// <userData>/ai-hub-profile-import.json：导入结果的可恢复元数据。
// 只存清洗过的计数与路径，绝不含浏览数据或任何密钥材料。
export const IMPORT_STATE_SCHEMA_VERSION = 1;

export type ProfileImportErrorCategory =
  | "source-unavailable"
  | "source-browser-running"
  | "keychain-denied"
  | "unsupported-profile"
  | "insufficient-disk-space"
  | "copy-failed"
  | "cookie-migration-failed"
  | "validation-failed"
  | "restart-required"
  | "chrome-unavailable"
  | "chrome-login-canceled"
  | "chrome-login-timeout"
  | "login-callback-origin-mismatch"
  | "cookie-sync-failed";

export interface ProfileImportState {
  schemaVersion: number;
  sourceId: string;
  completedAt: string;
  destinationPath: string;
  copiedBytes: number;
  importedCookieCount: number;
  skippedCookieCount: number;
  restartRequired: boolean;
  lastErrorCategory?: ProfileImportErrorCategory;
}

/** 清洗任意输入为可用元数据；结构不合法返回 null（调用方按未导入处理）。 */
export function normalizeProfileImportState(raw: unknown): ProfileImportState | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  if (entry.schemaVersion !== IMPORT_STATE_SCHEMA_VERSION) return null;
  const sourceId = typeof entry.sourceId === "string" ? entry.sourceId.slice(0, 64) : "";
  const destinationPath = typeof entry.destinationPath === "string" ? entry.destinationPath : "";
  const completedAt = typeof entry.completedAt === "string" ? entry.completedAt : "";
  if (!sourceId || !destinationPath || !completedAt) return null;
  const copiedBytes = toFiniteNumber(entry.copiedBytes);
  const importedCookieCount = toFiniteNumber(entry.importedCookieCount);
  const skippedCookieCount = toFiniteNumber(entry.skippedCookieCount);
  if (importedCookieCount === null || skippedCookieCount === null) return null;
  return {
    schemaVersion: IMPORT_STATE_SCHEMA_VERSION,
    sourceId,
    completedAt,
    destinationPath,
    copiedBytes: copiedBytes ?? 0,
    importedCookieCount,
    skippedCookieCount,
    restartRequired: entry.restartRequired === true,
    ...(isErrorCategory(entry.lastErrorCategory) ? { lastErrorCategory: entry.lastErrorCategory } : {}),
  };
}

export class ProfileImportStateStore {
  constructor(private readonly filePath: string) {}

  load(): ProfileImportState | null {
    if (!existsSync(this.filePath)) return null;
    try {
      return normalizeProfileImportState(JSON.parse(readFileSync(this.filePath, "utf8")));
    } catch {
      return null;
    }
  }

  save(state: ProfileImportState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, this.filePath);
  }
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

const ERROR_CATEGORIES: ReadonlySet<string> = new Set([
  "source-unavailable",
  "source-browser-running",
  "keychain-denied",
  "unsupported-profile",
  "insufficient-disk-space",
  "copy-failed",
  "cookie-migration-failed",
  "validation-failed",
  "restart-required",
  "chrome-unavailable",
  "chrome-login-canceled",
  "chrome-login-timeout",
  "login-callback-origin-mismatch",
  "cookie-sync-failed",
]);

function isErrorCategory(value: unknown): value is ProfileImportErrorCategory {
  return typeof value === "string" && ERROR_CATEGORIES.has(value);
}
