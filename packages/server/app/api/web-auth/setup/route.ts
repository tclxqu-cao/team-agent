import { NextResponse } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";
import { WebAuthError } from "@agent/core";
import { AUTH_COOKIE, DEVICE_COOKIE, authErrorResponse, clientInfoFromRequest, cookieOptions, webAuth } from "../../../../lib/web-auth/http";

const THIRTY_DAYS = 30 * 24 * 60 * 60;

export async function POST(request: Request) {
  try {
    const body = await request.json() as { username?: string; password?: string; pairingToken?: string };
    validatePairing(body.pairingToken);
    const result = await webAuth.setup(body.username || "", body.password || "", clientInfoFromRequest(request));
    const response = NextResponse.json({ user: result.user, csrfToken: result.csrfToken, deviceId: result.deviceId }, { status: 201 });
    response.cookies.set(AUTH_COOKIE, result.authToken, cookieOptions(request, THIRTY_DAYS, true));
    response.cookies.set(DEVICE_COOKIE, result.deviceId, cookieOptions(request, 365 * 24 * 60 * 60, false));
    return response;
  } catch (error) { return authErrorResponse(error); }
}

function validatePairing(raw:string|undefined){const expected=process.env.AGENT_PAIRING_HASH;if(!expected)return;const expiry=Date.parse(process.env.AGENT_PAIRING_EXPIRES_AT||"");const actual=createHash("sha256").update(raw||"").digest("hex");const valid=Number.isFinite(expiry)&&Date.now()<expiry&&actual.length===expected.length&&timingSafeEqual(Buffer.from(actual),Buffer.from(expected));if(!valid)throw new WebAuthError("INVALID_INPUT","配对链接无效或已过期",403);}
