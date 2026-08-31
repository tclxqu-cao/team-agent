import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteAuthStore } from "./SQLiteAuthStore.js";
import { SQLiteAnonymousWebStore } from "./SQLiteAnonymousWebStore.js";
import { getDatabase } from "./SQLiteDatabase.js";

describe("SQLiteAnonymousWebStore", () => {
  it("shares a hashed nonce across store instances and consumes it once", () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-anonymous-web-"));
    const issuer = new SQLiteAnonymousWebStore(base);
    const consumer = new SQLiteAnonymousWebStore(base);

    try {
      const principal = issuer.getOrCreatePrincipal();
      expect(principal).toEqual({ userId: "local-web", username: "local" });

      issuer.issueWsNonce("raw-secret-nonce", principal.userId, 2_000, 1_000);
      const row = getDatabase(base).db.prepare("SELECT nonce_hash FROM anonymous_ws_nonces").get() as { nonce_hash: Buffer };
      expect(row.nonce_hash.toString("utf8")).not.toContain("raw-secret-nonce");
      expect(consumer.consumeWsNonce("raw-secret-nonce", 1_500)).toBe(principal.userId);
      expect(consumer.consumeWsNonce("raw-secret-nonce", 1_500)).toBeNull();

      issuer.issueWsNonce("expired-nonce", principal.userId, 2_000, 1_000);
      expect(consumer.consumeWsNonce("expired-nonce", 2_000)).toBeNull();
    } finally {
      getDatabase(base).close();
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reuses the existing account id so passwordless mode preserves console state", () => {
    const base = mkdtempSync(join(tmpdir(), "customer-agent-anonymous-existing-"));
    const now = "2026-08-31T00:00:00.000Z";
    const authStore = new SQLiteAuthStore(base);
    authStore.createFirstUser({
      id: "existing-user",
      usernameNormalized: "existing",
      usernameDisplay: "Existing",
      passwordHash: Buffer.alloc(32, 1),
      passwordSalt: Buffer.alloc(16, 2),
      passwordVersion: 1,
      createdAt: now,
      passwordChangedAt: now,
    });

    try {
      expect(new SQLiteAnonymousWebStore(base).getOrCreatePrincipal())
        .toEqual({ userId: "existing-user", username: "local" });
      const count = getDatabase(base).db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number };
      expect(count.count).toBe(1);
    } finally {
      getDatabase(base).close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
