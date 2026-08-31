import { randomBytes } from "node:crypto";
import { SQLiteAnonymousWebStore } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";
import { webConsoleStore } from "./http";

export const WEB_ANON_USERNAME = "local";
export const WEB_ANON_DEVICE_ID = "browser";

export interface AnonymousPrincipal {
  userId: string;
  username: string;
  deviceId: string;
}

const anonymousWebStore = new SQLiteAnonymousWebStore(getServerBaseDir());
const TTL_MS = 60_000;

export function anonymousPrincipal(): AnonymousPrincipal {
  const principal = anonymousWebStore.getOrCreatePrincipal();
  return {
    userId: principal.userId,
    username: WEB_ANON_USERNAME,
    deviceId: WEB_ANON_DEVICE_ID,
  };
}

/** One-time nonce still prevents an arbitrary cross-origin page from opening WS. */
export function issueAnonymousWsNonce() {
  const now = Date.now();
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = now + TTL_MS;
  const principal = anonymousPrincipal();
  anonymousWebStore.issueWsNonce(nonce, principal.userId, expiresAt, now);
  return { nonce, expiresAt, principal };
}

export function consumeAnonymousWsNonce(nonce: string): AnonymousPrincipal {
  const userId = anonymousWebStore.consumeWsNonce(nonce);
  if (!userId) throw new Error("invalid nonce");
  return { userId, username: WEB_ANON_USERNAME, deviceId: WEB_ANON_DEVICE_ID };
}

export { webConsoleStore };
