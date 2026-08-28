import { SQLiteAuthStore, SQLiteWebConsoleStore, WebAuthError, WebAuthService, type AuthClientInfo, type AuthenticatedSession } from "@agent/core";
import { getServerBaseDir } from "../server-data-dir";

export const AUTH_COOKIE = "customer_agent_session";
export const DEVICE_COOKIE = "customer_agent_device";
export const CSRF_HEADER = "x-csrf-token";

export const webAuth = new WebAuthService(new SQLiteAuthStore(getServerBaseDir()));
export const webConsoleStore = new SQLiteWebConsoleStore(getServerBaseDir());

export function parseCookies(request: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

export function authTokenFromRequest(request: Request): string | null { return parseCookies(request)[AUTH_COOKIE] || null; }
export function clientInfoFromRequest(request: Request): AuthClientInfo {
  const cookies = parseCookies(request);
  return { ip: request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown", userAgent: request.headers.get("user-agent") || "", deviceId: cookies[DEVICE_COOKIE], deviceName: request.headers.get("x-device-name") || "" };
}
export function requireAuthenticated(request: Request): AuthenticatedSession { return webAuth.authenticateToken(authTokenFromRequest(request)); }
export function requireCsrf(request: Request): AuthenticatedSession { const auth = requireAuthenticated(request); webAuth.validateCsrf(auth, request.headers.get(CSRF_HEADER)); return auth; }
export function cookieOptions(request: Request, maxAgeSeconds: number, httpOnly: boolean) { const forwarded=process.env.AGENT_TRUST_TUNNEL_PROXY==="1"?request.headers.get("x-forwarded-proto"):null;return { httpOnly, sameSite: "strict" as const, secure: forwarded==="https"||new URL(request.url).protocol === "https:", path: "/", maxAge: maxAgeSeconds }; }
export function authErrorResponse(error: unknown): Response { const authError = error instanceof WebAuthError ? error : new WebAuthError("UNAUTHENTICATED", "认证失败", 401); return Response.json({ error: { code: authError.code, message: authError.message } }, { status: authError.status }); }
