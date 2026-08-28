import { NextResponse } from "next/server";
import { AUTH_COOKIE, authErrorResponse, authTokenFromRequest, cookieOptions, requireCsrf, webAuth } from "../../../../lib/web-auth/http";

export async function POST(request: Request) {
  try {
    requireCsrf(request);
    const token = authTokenFromRequest(request)!;
    const revoked = webAuth.revokeAll(token, false);
    const response = NextResponse.json({ revoked });
    response.cookies.set(AUTH_COOKIE, "", cookieOptions(request, 0, true));
    return response;
  } catch (error) { return authErrorResponse(error); }
}
