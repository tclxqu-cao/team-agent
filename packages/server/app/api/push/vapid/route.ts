import { NextResponse } from "next/server";
import { getWebPushService } from "../../../../lib/web-push-service.mjs";
import { ensurePushHook } from "../../../../lib/push-hook";

export async function GET() {
  try {
    ensurePushHook();
    return NextResponse.json({ publicKey: getWebPushService().getPublicKey() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Push is unavailable" },
      { status: 500 },
    );
  }
}
