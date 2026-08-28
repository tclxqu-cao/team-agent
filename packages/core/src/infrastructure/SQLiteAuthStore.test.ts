import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteDatabase } from "./SQLiteDatabase.js";
import { SQLiteAuthStore } from "./SQLiteAuthStore.js";

describe("auth schema", () => {
  it("creates users, auth_sessions, and login_attempts", () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-auth-"));
    const database = new SQLiteDatabase(base);

    try {
      const tables = database.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;

      expect(tables.map((row) => row.name)).toEqual(
        expect.arrayContaining(["users", "auth_sessions", "login_attempts"]),
      );
    } finally {
      database.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("SQLiteAuthStore", () => {
  it("persists users, sessions, one-time nonces, and login failures", () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-auth-store-"));
    const store = new SQLiteAuthStore(base);
    const now = "2026-08-27T00:00:00.000Z";
    const later = "2026-09-27T00:00:00.000Z";
    const user = { id: "u1", usernameNormalized: "caoqu", usernameDisplay: "caoqu", passwordHash: Buffer.alloc(32, 1), passwordSalt: Buffer.alloc(16, 2), passwordVersion: 1, createdAt: now, passwordChangedAt: now };
    expect(store.createFirstUser(user)).toEqual(user);
    expect(() => store.createFirstUser({ ...user, id: "u2" })).toThrow("setup already completed");
    expect(store.findUserById("u1")?.usernameDisplay).toBe("caoqu");

    const session = { id: "s1", userId: "u1", tokenHash: Buffer.alloc(32, 3), csrfHash: Buffer.alloc(32, 4), wsNonceHash: null, wsNonceExpiresAt: null, deviceId: "d1", deviceName: "phone", userAgent: "test", createdAt: now, lastSeenAt: now, expiresAt: later, revokedAt: null };
    store.createSession(session);
    expect(store.findSessionByTokenHash(session.tokenHash, now)?.id).toBe("s1");
    const nonce = Buffer.alloc(32, 5);
    store.issueWsNonce("s1", nonce, later);
    expect(store.consumeWsNonce("s1", nonce, now)).toBe(true);
    expect(store.consumeWsNonce("s1", nonce, now)).toBe(false);

    store.recordLoginFailure("caoqu", "127.0.0.1", now);
    expect(store.countRecentLoginFailures("caoqu", "127.0.0.1", now)).toBe(1);
    store.clearLoginFailures("caoqu", "127.0.0.1");
    expect(store.countRecentLoginFailures("caoqu", "127.0.0.1", now)).toBe(0);

    rmSync(base, { recursive: true, force: true });
  });
});
