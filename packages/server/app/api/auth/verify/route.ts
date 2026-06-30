import { NextResponse } from "next/server";

/**
 * Token verification endpoint.
 * SDK calls this on init to validate the token.
 *
 * For MVP: token is checked against AGENT_SDK_TOKEN env var.
 * If env var is not set, all tokens are accepted (dev mode).
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("Authorization");
  const token = authHeader?.replace("Bearer ", "");

  // Also accept token as query param (for SSE compatibility)
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const finalToken = token || queryToken;

  const expectedToken = process.env.AGENT_SDK_TOKEN;

  // Dev mode: no token configured, accept all
  if (!expectedToken) {
    return NextResponse.json({ valid: true, project: "dev" });
  }

  if (finalToken === expectedToken) {
    return NextResponse.json({ valid: true, project: "default" });
  }

  return NextResponse.json({ valid: false }, { status: 401 });
}
