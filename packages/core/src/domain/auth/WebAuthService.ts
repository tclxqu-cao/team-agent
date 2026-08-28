import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { AuthSession, AuthStore, User } from "./index.js";
import { hashPassword, verifyPassword } from "./password.js";

const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;
const WS_NONCE_MS = 60 * 1000;

export type AuthErrorCode = "INVALID_INPUT" | "SETUP_COMPLETED" | "INVALID_CREDENTIALS" | "RATE_LIMITED" | "UNAUTHENTICATED" | "INVALID_CSRF" | "INVALID_NONCE";

export class WebAuthError extends Error {
  constructor(readonly code: AuthErrorCode, message: string, readonly status: number) { super(message); }
}

export interface AuthClientInfo { ip: string; userAgent: string; deviceId?: string; deviceName?: string }
export interface AuthResult { user: { id: string; username: string }; sessionId: string; authToken: string; csrfToken: string; expiresAt: string; deviceId: string }
export interface WebPrincipal { userId: string; username: string; sessionId: string; deviceId: string }
export interface AuthenticatedSession { principal: WebPrincipal; session: AuthSession }

export class WebAuthService {
  constructor(private readonly store: AuthStore, private readonly now: () => Date = () => new Date()) {}

  needsSetup(): boolean { return this.store.countUsers() === 0; }

  async setup(username: string, password: string, client: AuthClientInfo): Promise<AuthResult> {
    if (!this.needsSetup()) throw new WebAuthError("SETUP_COMPLETED", "初始化已完成", 409);
    const normalized = normalizeUsername(username);
    validateCredentials(normalized, password);
    const now = this.now().toISOString();
    const record = await hashPassword(password);
    let user: User;
    try {
      user = this.store.createFirstUser({ id: randomUUID(), usernameNormalized: normalized, usernameDisplay: username.trim(), passwordHash: record.hash, passwordSalt: record.salt, passwordVersion: record.version, createdAt: now, passwordChangedAt: now });
    } catch {
      throw new WebAuthError("SETUP_COMPLETED", "初始化已完成", 409);
    }
    return this.createLoginSession(user, client);
  }

  async login(username: string, password: string, client: AuthClientInfo): Promise<AuthResult> {
    const normalized = normalizeUsername(username);
    const now = this.now();
    const since = new Date(now.getTime() - FAILURE_WINDOW_MS).toISOString();
    if (this.store.countRecentLoginFailures(normalized, client.ip, since) >= MAX_FAILURES) {
      throw new WebAuthError("RATE_LIMITED", "登录尝试过多，请稍后再试", 429);
    }
    const user = this.store.findUserByNormalizedUsername(normalized);
    const valid = user ? await verifyPassword(password, { hash: user.passwordHash, salt: user.passwordSalt, version: user.passwordVersion }) : false;
    if (!user || !valid) {
      this.store.recordLoginFailure(normalized, client.ip, now.toISOString());
      throw new WebAuthError("INVALID_CREDENTIALS", "用户名或密码错误", 401);
    }
    this.store.clearLoginFailures(normalized, client.ip);
    return this.createLoginSession(user, client);
  }

  authenticateToken(rawToken: string | null | undefined): AuthenticatedSession {
    if (!rawToken) throw new WebAuthError("UNAUTHENTICATED", "请先登录", 401);
    const now = this.now().toISOString();
    const session = this.store.findSessionByTokenHash(hashToken(rawToken), now);
    if (!session) throw new WebAuthError("UNAUTHENTICATED", "登录已失效", 401);
    const user = this.store.findUserById(session.userId);
    if (!user) throw new WebAuthError("UNAUTHENTICATED", "用户不存在", 401);
    return { principal: { userId: user.id, username: user.usernameDisplay, sessionId: session.id, deviceId: session.deviceId }, session };
  }

  refresh(rawToken: string): { principal: WebPrincipal; csrfToken: string; expiresAt: string } {
    const authenticated = this.authenticateToken(rawToken);
    const csrfToken = randomToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + SESSION_MS).toISOString();
    this.store.rotateCsrf(authenticated.session.id, hashToken(csrfToken), now.toISOString(), expiresAt);
    return { principal: authenticated.principal, csrfToken, expiresAt };
  }

  validateCsrf(authenticated: AuthenticatedSession, rawCsrf: string | null | undefined): void {
    if (!rawCsrf || !safeEqual(hashToken(rawCsrf), authenticated.session.csrfHash)) {
      throw new WebAuthError("INVALID_CSRF", "CSRF 校验失败", 403);
    }
  }

  issueWsNonce(rawToken: string): { nonce: string; expiresAt: string; principal: WebPrincipal } {
    const authenticated = this.authenticateToken(rawToken);
    const nonce = randomToken();
    const expiresAt = new Date(this.now().getTime() + WS_NONCE_MS).toISOString();
    this.store.issueWsNonce(authenticated.session.id, hashToken(nonce), expiresAt);
    return { nonce, expiresAt, principal: authenticated.principal };
  }

  consumeWsNonce(rawToken: string, nonce: string): WebPrincipal {
    const authenticated = this.authenticateToken(rawToken);
    if (!this.store.consumeWsNonce(authenticated.session.id, hashToken(nonce), this.now().toISOString())) {
      throw new WebAuthError("INVALID_NONCE", "连接凭证无效", 403);
    }
    return authenticated.principal;
  }

  logout(rawToken: string): void { const auth = this.authenticateToken(rawToken); this.store.revokeSession(auth.session.id, this.now().toISOString()); }
  revokeAll(rawToken: string, keepCurrent = true): number { const auth = this.authenticateToken(rawToken); return this.store.revokeUserSessions(auth.principal.userId, keepCurrent ? auth.session.id : null, this.now().toISOString()); }

  private createLoginSession(user: User, client: AuthClientInfo): AuthResult {
    const now = this.now();
    const authToken = randomToken();
    const csrfToken = randomToken();
    const deviceId = client.deviceId || randomUUID();
    const expiresAt = new Date(now.getTime() + SESSION_MS).toISOString();
    const session: AuthSession = { id: randomUUID(), userId: user.id, tokenHash: hashToken(authToken), csrfHash: hashToken(csrfToken), wsNonceHash: null, wsNonceExpiresAt: null, deviceId, deviceName: client.deviceName || "", userAgent: client.userAgent, createdAt: now.toISOString(), lastSeenAt: now.toISOString(), expiresAt, revokedAt: null };
    this.store.createSession(session);
    return { user: { id: user.id, username: user.usernameDisplay }, sessionId: session.id, authToken, csrfToken, expiresAt, deviceId };
  }
}

export function normalizeUsername(value: string): string { return value.trim().normalize("NFKC").toLowerCase(); }
export function hashToken(value: string): Buffer { return createHash("sha256").update(value).digest(); }
function randomToken(): string { return randomBytes(32).toString("base64url"); }
function safeEqual(a: Buffer, b: Buffer): boolean { return a.byteLength === b.byteLength && timingSafeEqual(a, b); }
function validateCredentials(username: string, password: string): void {
  if (!/^[a-z0-9._-]{3,64}$/.test(username)) throw new WebAuthError("INVALID_INPUT", "用户名需为 3-64 位字母、数字或 ._-", 400);
  if (password.length < 10) throw new WebAuthError("INVALID_INPUT", "密码至少 10 位", 400);
}
