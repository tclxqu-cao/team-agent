import { NextResponse } from "next/server";
import { AUTH_COOKIE, DEVICE_COOKIE, authErrorResponse, clientInfoFromRequest, cookieOptions, webAuth } from "../../../../lib/web-auth/http";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { username?: string; password?: string };
    const result = await webAuth.login(body.username || "", body.password || "", clientInfoFromRequest(request));
    const response = NextResponse.json({ user: result.user, csrfToken: result.csrfToken, deviceId: result.deviceId });
    response.cookies.set(AUTH_COOKIE, result.authToken, cookieOptions(request, THIRTY_DAYS, true));
    response.cookies.set(DEVICE_COOKIE, result.deviceId, cookieOptions(request, 365 * 24 * 60 * 60, false));
    return response;
  } catch (error) { return authErrorResponse(error); }
}
