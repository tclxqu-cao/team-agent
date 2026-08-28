import { NextResponse } from "next/server";
import { authErrorResponse, authTokenFromRequest, webAuth, webConsoleStore } from "../../../../lib/web-auth/http";

export async function GET(request: Request) {
  try {
    const token = authTokenFromRequest(request);
    if (!token) return authErrorResponse(new Error("unauthenticated"));
    const result = webAuth.issueWsNonce(token);
    return NextResponse.json({ user: { id: result.principal.userId, username: result.principal.username }, deviceId: result.principal.deviceId, wsNonce: result.nonce, wsNonceExpiresAt: result.expiresAt, tabs:webConsoleStore.listTabs(result.principal.userId),preferences:webConsoleStore.getPreferences(result.principal.userId),deviceState:webConsoleStore.getDeviceState(result.principal.userId,result.principal.deviceId) });
  } catch (error) { return authErrorResponse(error); }
}
