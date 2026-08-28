// ── Auth Domain ──

export interface User {
  id: string;
  usernameNormalized: string;
  usernameDisplay: string;
  passwordHash: Buffer;
  passwordSalt: Buffer;
  passwordVersion: number;
  createdAt: string;
  passwordChangedAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  tokenHash: Buffer;
  csrfHash: Buffer;
  wsNonceHash: Buffer | null;
  wsNonceExpiresAt: string | null;
  deviceId: string;
  deviceName: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export type CreateUserInput = User;
export type CreateAuthSessionInput = AuthSession;
