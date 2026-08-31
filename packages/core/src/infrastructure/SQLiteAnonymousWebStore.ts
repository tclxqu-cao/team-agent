import { createHash, randomBytes } from "node:crypto";
import { getDatabase } from "./SQLiteDatabase.js";

export interface AnonymousWebPrincipal {
  userId: string;
  username: string;
}

type UserRow = { id: string; username_display: string };

const LOCAL_USER_ID = "local-web";
const LOCAL_USERNAME = "local";

function hashNonce(nonce: string): Buffer {
  return createHash("sha256").update(nonce).digest();
}

export class SQLiteAnonymousWebStore {
  private readonly db;

  constructor(baseDir: string) {
    this.db = getDatabase(baseDir).db;
  }

  getOrCreatePrincipal(): AnonymousWebPrincipal {
    const existing = this.findPrincipal();
    if (existing) return { userId: existing.id, username: LOCAL_USERNAME };

    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT OR IGNORE INTO users (
        id, username_normalized, username_display, password_hash, password_salt,
        password_version, created_at, password_changed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      LOCAL_USER_ID,
      LOCAL_USERNAME,
      LOCAL_USERNAME,
      randomBytes(32),
      randomBytes(16),
      1,
      now,
      now,
    );

    const created = this.findPrincipal();
    if (!created) throw new Error("failed to initialize anonymous web principal");
    return { userId: created.id, username: LOCAL_USERNAME };
  }

  issueWsNonce(nonce: string, userId: string, expiresAt: number, now = Date.now()): void {
    const nonceHash = hashNonce(nonce);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM anonymous_ws_nonces WHERE expires_at <= ?").run(now);
      this.db.prepare("INSERT INTO anonymous_ws_nonces (nonce_hash, user_id, expires_at) VALUES (?, ?, ?)")
        .run(nonceHash, userId, expiresAt);
    })();
  }

  consumeWsNonce(nonce: string, now = Date.now()): string | null {
    const row = this.db.prepare(`
      DELETE FROM anonymous_ws_nonces
      WHERE nonce_hash = ? AND expires_at > ?
      RETURNING user_id
    `).get(hashNonce(nonce), now) as { user_id: string } | undefined;
    return row?.user_id ?? null;
  }

  private findPrincipal(): UserRow | undefined {
    return this.db.prepare("SELECT id, username_display FROM users ORDER BY created_at, id LIMIT 1")
      .get() as UserRow | undefined;
  }
}
