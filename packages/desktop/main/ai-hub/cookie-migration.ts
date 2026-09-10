import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ── Electron CookiesSetDetails（进程内传递，绝不跨 IPC / 不落日志） ──
export interface ElectronCookieDetails {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  expirationDate?: number;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
}

// Chromium Cookies 库的行（只取迁移需要的列；node:sqlite 返回 null 或数值）
export interface ChromiumCookieRow {
  host_key: string | null;
  name: string | null;
  value: string | null;
  encrypted_value: Uint8Array | null;
  path: string | null;
  expires_utc: number | null;
  is_secure: number | null;
  is_httponly: number | null;
  is_persistent: number | null;
  has_expires: number | null;
  samesite: number | null;
  top_frame_site_id?: string | null;
  partition_id?: number | null;
}

export interface SkipCounters {
  expired: number;
  malformed: number;
  partitioned: number;
  undecryptable: number;
}

// ── Chromium v10（macOS）解密：PBKDF2-SHA1(1003, "saltysalt") → AES-128-CBC(IV=16 空格) ──

export function deriveChromiumCookieKey(secret: string): Buffer {
  return pbkdf2Sync(secret, "saltysalt", 1003, 16, "sha1");
}

export function decryptChromiumV10Value(encrypted: Buffer, secret: string): string | null {
  if (encrypted.length < 3 || encrypted.subarray(0, 3).toString("latin1") !== "v10") return null;
  try {
    const decipher = createDecipheriv("aes-128-cbc", deriveChromiumCookieKey(secret), Buffer.alloc(16, 0x20));
    const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    return decrypted.toString("utf8");
  } catch {
    return null; // 填充错误 = 密钥不符或数据损坏，交由调用方按 skip 计数
  }
}

// Chromium 时间戳：1601-01-01 起的微秒 → Unix 秒
export function chromeTimestampToUnixSeconds(micros: number): number {
  return micros / 1_000_000 - 11_644_473_600;
}

export function mapChromiumSameSite(value: number | null): ElectronCookieDetails["sameSite"] {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}

export type CookieRowOutcome =
  | { status: "ok"; details: ElectronCookieDetails }
  | { status: "skip"; reason: keyof SkipCounters };

/** 单行迁移决策：过期/畸形/分区/不可解密都按类别跳过，绝不抛出值本身。 */
export function chromiumRowToCookieDetails(
  row: ChromiumCookieRow,
  secret: string,
  nowUnixSec: number,
): CookieRowOutcome {
  const name = row.name ?? "";
  const hostKey = row.host_key ?? "";
  if (name.length === 0 || hostKey.length === 0) return { status: "skip", reason: "malformed" };

  const topFrameSite = row.top_frame_site_id;
  if ((typeof topFrameSite === "string" && topFrameSite.length > 0)
    || (typeof row.partition_id === "number" && row.partition_id !== 0 && Number.isFinite(row.partition_id))) {
    return { status: "skip", reason: "partitioned" };
  }

  const persistent = row.is_persistent !== 0;
  const expiresUtc = row.expires_utc ?? 0;
  const hasExpires = row.has_expires !== 0 && expiresUtc > 0;
  if (persistent && hasExpires && chromeTimestampToUnixSeconds(expiresUtc) <= nowUnixSec) {
    return { status: "skip", reason: "expired" };
  }

  const encrypted = row.encrypted_value;
  let value: string | null = null;
  if (encrypted && encrypted.byteLength > 0) {
    value = decryptChromiumV10Value(Buffer.from(encrypted), secret);
    if (value === null) return { status: "skip", reason: "undecryptable" };
  } else {
    value = row.value ?? ""; // 旧 Profile 的明文 cookie（合法情形）
  }

  const hostOnly = !hostKey.startsWith(".");
  const path = typeof row.path === "string" && row.path.startsWith("/") ? row.path : "/";
  const url = `https://${hostOnly ? hostKey : hostKey.slice(1)}${path}`;
  return {
    status: "ok",
    details: {
      url,
      name,
      value,
      ...(hostOnly ? {} : { domain: hostKey }),
      path,
      secure: row.is_secure === 1,
      httpOnly: row.is_httponly === 1,
      ...(persistent && hasExpires ? { expirationDate: chromeTimestampToUnixSeconds(expiresUtc) } : {}),
      sameSite: mapChromiumSameSite(row.samesite ?? null),
    },
  };
}

export interface CookieMigrationSummary {
  details: ElectronCookieDetails[];
  imported: number;
  skipped: SkipCounters;
  total: number;
}

export interface CollectCookiesDeps {
  rows: ChromiumCookieRow[];
  keychainSecret: string;
  nowUnixSec?: number;
}

export function collectCookieDetails(deps: CollectCookiesDeps): CookieMigrationSummary {
  const nowUnixSec = deps.nowUnixSec ?? Math.floor(Date.now() / 1000);
  const summary: CookieMigrationSummary = {
    details: [],
    imported: 0,
    skipped: { expired: 0, malformed: 0, partitioned: 0, undecryptable: 0 },
    total: deps.rows.length,
  };
  for (const row of deps.rows) {
    const outcome = chromiumRowToCookieDetails(row, deps.keychainSecret, nowUnixSec);
    if (outcome.status === "ok") {
      summary.details.push(outcome.details);
      summary.imported += 1;
    } else {
      summary.skipped[outcome.reason] += 1;
    }
  }
  return summary;
}

/** 从 staging 快照只读打开 Cookies 库；仅在主进程（Electron 内置 node:sqlite）可用。 */
export async function readChromiumCookieRows(dbPath: string): Promise<ChromiumCookieRow[]> {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(
      "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly,"
      + " is_persistent, has_expires, samesite, top_frame_site_id, partition_id FROM cookies",
    ).all() as unknown as ChromiumCookieRow[];
  } finally {
    db.close();
  }
}

export interface KeychainDeps {
  run?: (file: string, args: string[]) => Promise<string>;
}

/** 读取浏览器 Safe Storage 密钥；任何失败都归为 keychain-denied，不区分错误细节。 */
export async function readKeychainSecret(service: string, deps: KeychainDeps = {}): Promise<string> {
  const run = deps.run ?? (async (file, args) => {
    const { stdout } = await execFileAsync(file, args);
    return stdout;
  });
  const stdout = await run("security", ["find-generic-password", "-w", "-s", service]);
  return stdout.replace(/\r?\n$/, "");
}

// ── CDP（托管 Chrome 重登录）cookie → Electron details ──

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number; // Unix 秒；会话 cookie 为 -1
  httpOnly: boolean;
  secure: boolean;
  sameSite?: string;
  partitionKey?: unknown;
  partitionKeyOpaque?: boolean;
}

export function cdpCookieToElectronDetails(cookie: CdpCookie): ElectronCookieDetails {
  const hostOnly = !cookie.domain.startsWith(".");
  const path = cookie.path.startsWith("/") ? cookie.path : "/";
  return {
    url: `https://${hostOnly ? cookie.domain : cookie.domain.slice(1)}${path}`,
    name: cookie.name,
    value: cookie.value,
    ...(hostOnly ? {} : { domain: cookie.domain }),
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
    sameSite: cookie.sameSite === "Strict" ? "strict"
      : cookie.sameSite === "Lax" ? "lax"
      : cookie.sameSite === "None" ? "no_restriction"
      : "unspecified",
  };
}

/** 只保留属于目标站点域（含父域匹配）的 cookie；Google 域由调用方一并传入。 */
export function cookiesBelongingToHosts<T extends { domain: string }>(cookies: T[], hosts: string[]): T[] {
  const normalizedHosts = hosts.map((host) => host.toLowerCase().replace(/^\.+/, "")).filter(Boolean);
  return cookies.filter((cookie) => {
    const cookieDomain = cookie.domain.toLowerCase().replace(/^\.+/, "");
    return normalizedHosts.some((host) => cookieDomain === host || cookieDomain.endsWith(`.${host}`));
  });
}
