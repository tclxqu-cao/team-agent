import { randomBytes } from "node:crypto";
import { webConsoleStore } from "./http";

export const WEB_ANON_USER_ID = "local-web";
export const WEB_ANON_USERNAME = "local";
export const WEB_ANON_DEVICE_ID = "browser";

export interface AnonymousPrincipal {
  userId: string;
  username: string;
  deviceId: string;
}

const globalAnon = globalThis as typeof globalThis & {
  __webAnonNonces?: Map<string, number>;
};
const nonces = globalAnon.__webAnonNonces ?? new Map<string, number>();
globalAnon.__webAnonNonces = nonces;
const TTL_MS = 60_000;

export function anonymousPrincipal(): AnonymousPrincipal {
  return {
    userId: WEB_ANON_USER_ID,
    username: WEB_ANON_USERNAME,
    deviceId: WEB_ANON_DEVICE_ID,
  };
}

/** One-time nonce still prevents an arbitrary cross-origin page from opening WS. */
export function issueAnonymousWsNonce() {
  const now = Date.now();
  for (const [nonce, expiresAt] of nonces) if (expiresAt <= now) nonces.delete(nonce);
  const nonce = randomBytes(24).toString("base64url");
  const expiresAt = now + TTL_MS;
  nonces.set(nonce, expiresAt);
  return { nonce, expiresAt, principal: anonymousPrincipal() };
}

export function consumeAnonymousWsNonce(nonce: string): AnonymousPrincipal {
  const expiresAt = nonces.get(nonce);
  nonces.delete(nonce);
  if (!expiresAt || expiresAt <= Date.now()) throw new Error("invalid nonce");
  return anonymousPrincipal();
}

export { webConsoleStore };
