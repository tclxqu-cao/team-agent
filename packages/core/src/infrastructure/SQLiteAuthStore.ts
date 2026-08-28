import type Database from "better-sqlite3";
import type { AuthSession, AuthStore, CreateAuthSessionInput, CreateUserInput, User } from "../domain/auth/index.js";
import { getDatabase } from "./SQLiteDatabase.js";

type UserRow = { id: string; username_normalized: string; username_display: string; password_hash: Buffer; password_salt: Buffer; password_version: number; created_at: string; password_changed_at: string };
type SessionRow = { id: string; user_id: string; token_hash: Buffer; csrf_hash: Buffer; ws_nonce_hash: Buffer | null; ws_nonce_expires_at: string | null; device_id: string; device_name: string | null; user_agent: string | null; created_at: string; last_seen_at: string; expires_at: string; revoked_at: string | null };

export class SQLiteAuthStore implements AuthStore {
  private readonly db: Database;
  constructor(baseDir: string) { this.db = getDatabase(baseDir).db; }

  countUsers(): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count; }

  createFirstUser(input: CreateUserInput): User {
    const create = this.db.transaction(() => {
      if (this.countUsers() !== 0) throw new Error("setup already completed");
      this.db.prepare(`INSERT INTO users (id, username_normalized, username_display, password_hash, password_salt, password_version, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(input.id, input.usernameNormalized, input.usernameDisplay, input.passwordHash, input.passwordSalt, input.passwordVersion, input.createdAt, input.passwordChangedAt);
      return input;
    });
    return create() as User;
  }

  findUserById(id: string): User | null { const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined; return row ? this.rowToUser(row) : null; }
  findUserByNormalizedUsername(username: string): User | null { const row = this.db.prepare("SELECT * FROM users WHERE username_normalized = ?").get(username) as UserRow | undefined; return row ? this.rowToUser(row) : null; }

  createSession(input: CreateAuthSessionInput): AuthSession {
    this.db.prepare(`INSERT INTO auth_sessions (id, user_id, token_hash, csrf_hash, ws_nonce_hash, ws_nonce_expires_at, device_id, device_name, user_agent, created_at, last_seen_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.userId, input.tokenHash, input.csrfHash, input.wsNonceHash, input.wsNonceExpiresAt, input.deviceId, input.deviceName, input.userAgent, input.createdAt, input.lastSeenAt, input.expiresAt, input.revokedAt);
    return input;
  }

  findSessionByTokenHash(tokenHash: Buffer, now: string): AuthSession | null {
    const row = this.db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?").get(tokenHash, now) as SessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  rotateCsrf(sessionId: string, csrfHash: Buffer, lastSeenAt: string, expiresAt: string): void {
    this.db.prepare("UPDATE auth_sessions SET csrf_hash = ?, last_seen_at = ?, expires_at = ? WHERE id = ? AND revoked_at IS NULL").run(csrfHash, lastSeenAt, expiresAt, sessionId);
  }

  issueWsNonce(sessionId: string, nonceHash: Buffer, expiresAt: string): void {
    this.db.prepare("UPDATE auth_sessions SET ws_nonce_hash = ?, ws_nonce_expires_at = ? WHERE id = ? AND revoked_at IS NULL").run(nonceHash, expiresAt, sessionId);
  }

  consumeWsNonce(sessionId: string, nonceHash: Buffer, now: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT id FROM auth_sessions WHERE id = ? AND ws_nonce_hash = ? AND ws_nonce_expires_at > ? AND revoked_at IS NULL").get(sessionId, nonceHash, now) as { id: string } | undefined;
      if (!row) return false;
      return this.db.prepare("UPDATE auth_sessions SET ws_nonce_hash = NULL, ws_nonce_expires_at = NULL WHERE id = ? AND ws_nonce_hash = ?").run(sessionId, nonceHash).changes === 1;
    })();
  }

  revokeSession(sessionId: string, revokedAt: string): void { this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(revokedAt, sessionId); }
  revokeUserSessions(userId: string, exceptSessionId: string | null, revokedAt: string): number {
    return (exceptSessionId
      ? this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL").run(revokedAt, userId, exceptSessionId)
      : this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(revokedAt, userId)).changes;
  }
  recordLoginFailure(usernameNormalized: string, ip: string, attemptedAt: string): void { this.db.prepare("INSERT INTO login_attempts (username_normalized, ip, attempted_at) VALUES (?, ?, ?)").run(usernameNormalized, ip, attemptedAt); }
  countRecentLoginFailures(usernameNormalized: string, ip: string, since: string): number { return (this.db.prepare("SELECT COUNT(*) AS count FROM login_attempts WHERE username_normalized = ? AND ip = ? AND attempted_at >= ?").get(usernameNormalized, ip, since) as { count: number }).count; }
  clearLoginFailures(usernameNormalized: string, ip: string): void { this.db.prepare("DELETE FROM login_attempts WHERE username_normalized = ? AND ip = ?").run(usernameNormalized, ip); }

  private rowToUser(row: UserRow): User { return { id: row.id, usernameNormalized: row.username_normalized, usernameDisplay: row.username_display, passwordHash: row.password_hash, passwordSalt: row.password_salt, passwordVersion: row.password_version, createdAt: row.created_at, passwordChangedAt: row.password_changed_at }; }
  private rowToSession(row: SessionRow): AuthSession { return { id: row.id, userId: row.user_id, tokenHash: row.token_hash, csrfHash: row.csrf_hash, wsNonceHash: row.ws_nonce_hash, wsNonceExpiresAt: row.ws_nonce_expires_at, deviceId: row.device_id, deviceName: row.device_name ?? "", userAgent: row.user_agent ?? "", createdAt: row.created_at, lastSeenAt: row.last_seen_at, expiresAt: row.expires_at, revokedAt: row.revoked_at }; }
}
