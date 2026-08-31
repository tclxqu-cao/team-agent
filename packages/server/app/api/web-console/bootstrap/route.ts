import { NextResponse } from "next/server";
import { issueAnonymousWsNonce, webConsoleStore } from "../../../../lib/web-auth/anonymous";

/** Passwordless bootstrap for the private/LAN web console. */
export async function GET() {
  const result = issueAnonymousWsNonce();
  const { userId, username, deviceId } = result.principal;
  return NextResponse.json({
    user: { id: userId, username },
    deviceId,
    wsNonce: result.nonce,
    wsNonceExpiresAt: result.expiresAt,
    tabs: webConsoleStore.listTabs(userId),
    preferences: webConsoleStore.getPreferences(userId),
    deviceState: webConsoleStore.getDeviceState(userId, deviceId),
  });
}
