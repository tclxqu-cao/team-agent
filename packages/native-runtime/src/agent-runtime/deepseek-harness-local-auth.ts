import { createHash, createHmac } from "node:crypto";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";

const COOKIE_LIFETIME_MS = 5 * 60_000;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

/** Native browser-session v1 codec; reads only the local carrier grant, never model/account keys. */
export function createHarnessLocalCookie(origin: string, document: string, now = Date.now()): string | null {
  try {
    const address = new URL(origin);
    if (address.origin !== origin || !["http:", "https:"].includes(address.protocol)
      || !["127.0.0.1", "localhost", "[::1]"].includes(address.hostname)) return null;
    const yaml = parseDocument(document, { uniqueKeys: true, prettyErrors: false });
    if (yaml.errors.length) return null;
    const root = record(yaml.toJS({ maxAliasCount: 100 }));
    const grant = record(record(root?.records)?.["client-connection/browser-session"]);
    const payload = record(grant?.payload);
    if (root?.version !== 1 || grant?.kind !== "grant" || payload?.version !== 1
      || typeof payload.secret !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(payload.secret)) return null;
    const secret = Buffer.from(payload.secret, "base64url");
    if (secret.length !== 32 || secret.toString("base64url") !== payload.secret) return null;
    // HTTPS's native cookie audience includes the scheme; HTTP uses the bare authority.
    const authority = address.protocol === "https:" ? address.origin : address.host;
    const body = Buffer.from(JSON.stringify({ version: 1, authority, issuedAt: now,
      expiresAt: now + COOKIE_LIFETIME_MS })).toString("base64url");
    const signature = createHmac("sha256", secret).update(body).digest("base64url");
    const name = createHash("sha256").update(authority).digest("base64url");
    return `dsh-auth-${name}=v1.${body}.${signature}`;
  } catch {
    // YAML diagnostics quote secrets. Optional discovery must never publish those errors.
    return null;
  }
}

/** Reuse the current user's native browser grant without changing Harness's credentials store. */
export async function readHarnessLocalCookie(origin: string, environment: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const home = environment.DSH_HOME?.trim();
  const filename = join(home ? resolve(home.startsWith("~/") ? join(homedir(), home.slice(2)) : home) : join(homedir(), ".dsh"), ".credentials.yaml");
  try {
    const file = await open(filename, "r");
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > MAX_CREDENTIAL_BYTES) return null;
      if (process.platform !== "win32"
        && ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.())) return null;
      return createHarnessLocalCookie(origin, await file.readFile("utf8"));
    } finally { await file.close(); }
  } catch { return null; }
}
