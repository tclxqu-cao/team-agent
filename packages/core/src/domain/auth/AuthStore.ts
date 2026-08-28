import type {
  AuthSession,
  CreateAuthSessionInput,
  CreateUserInput,
  User,
} from './entities.js';

export interface AuthStore {
  countUsers(): number;
  createFirstUser(input: CreateUserInput): User;
  findUserById(id: string): User | null;
  findUserByNormalizedUsername(username: string): User | null;
  createSession(input: CreateAuthSessionInput): AuthSession;
  findSessionByTokenHash(tokenHash: Buffer, now: string): AuthSession | null;
  rotateCsrf(sessionId: string, csrfHash: Buffer, lastSeenAt: string, expiresAt: string): void;
  issueWsNonce(sessionId: string, nonceHash: Buffer, expiresAt: string): void;
  consumeWsNonce(sessionId: string, nonceHash: Buffer, now: string): boolean;
  revokeSession(sessionId: string, revokedAt: string): void;
  revokeUserSessions(userId: string, exceptSessionId: string | null, revokedAt: string): number;
  recordLoginFailure(usernameNormalized: string, ip: string, attemptedAt: string): void;
  countRecentLoginFailures(usernameNormalized: string, ip: string, since: string): number;
  clearLoginFailures(usernameNormalized: string, ip: string): void;
}
