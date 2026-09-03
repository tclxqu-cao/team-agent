import { NextResponse } from "next/server";
import { AUTH_COOKIE, DEVICE_COOKIE, authErrorResponse, authTokenFromRequest, cookieOptions, webAuth } from "../../../../lib/web-auth/http";

export const dynamic = "force-dynamic";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export async function GET(request: Request) {
  if (webAuth.needsSetup()) return NextResponse.json({ needsSetup: true, authenticated: false });
  const token = authTokenFromRequest(request);
  if (!token) return NextResponse.json({ needsSetup: false, authenticated: false });
  try {
    const refreshed = webAuth.refresh(token);
    const response = NextResponse.json({ needsSetup: false, authenticated: true, user: { id: refreshed.principal.userId, username: refreshed.principal.username }, csrfToken: refreshed.csrfToken, deviceId: refreshed.principal.deviceId });
    response.cookies.set(AUTH_COOKIE, token, cookieOptions(request, THIRTY_DAYS, true));
    response.cookies.set(DEVICE_COOKIE, refreshed.principal.deviceId, cookieOptions(request, 365 * 24 * 60 * 60, false));
    return response;
  } catch (error) {
    const response = NextResponse.json({ needsSetup: false, authenticated: false });
    response.cookies.set(AUTH_COOKIE, "", cookieOptions(request, 0, true));
    return response;
  }
}
