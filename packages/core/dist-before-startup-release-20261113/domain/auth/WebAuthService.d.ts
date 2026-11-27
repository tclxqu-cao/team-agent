import type { AuthSession, AuthStore } from "./index.js";
export type AuthErrorCode = "INVALID_INPUT" | "SETUP_COMPLETED" | "INVALID_CREDENTIALS" | "RATE_LIMITED" | "UNAUTHENTICATED" | "INVALID_CSRF" | "INVALID_NONCE";
export declare class WebAuthError extends Error {
    readonly code: AuthErrorCode;
    readonly status: number;
    constructor(code: AuthErrorCode, message: string, status: number);
}
export interface AuthClientInfo {
    ip: string;
    userAgent: string;
    deviceId?: string;
    deviceName?: string;
}
export interface AuthResult {
    user: {
        id: string;
        username: string;
    };
    sessionId: string;
    authToken: string;
    csrfToken: string;
    expiresAt: string;
    deviceId: string;
}
export interface WebPrincipal {
    userId: string;
    username: string;
    sessionId: string;
    deviceId: string;
}
export interface AuthenticatedSession {
    principal: WebPrincipal;
    session: AuthSession;
}
export declare class WebAuthService {
    private readonly store;
    private readonly now;
    constructor(store: AuthStore, now?: () => Date);
    needsSetup(): boolean;
    setup(username: string, password: string, client: AuthClientInfo): Promise<AuthResult>;
    login(username: string, password: string, client: AuthClientInfo): Promise<AuthResult>;
    authenticateToken(rawToken: string | null | undefined): AuthenticatedSession;
    refresh(rawToken: string): {
        principal: WebPrincipal;
        csrfToken: string;
        expiresAt: string;
    };
    validateCsrf(authenticated: AuthenticatedSession, rawCsrf: string | null | undefined): void;
    issueWsNonce(rawToken: string): {
        nonce: string;
        expiresAt: string;
        principal: WebPrincipal;
    };
    consumeWsNonce(rawToken: string, nonce: string): WebPrincipal;
    logout(rawToken: string): void;
    revokeAll(rawToken: string, keepCurrent?: boolean): number;
    private createLoginSession;
}
export declare function normalizeUsername(value: string): string;
export declare function hashToken(value: string): Buffer;
//# sourceMappingURL=WebAuthService.d.ts.map