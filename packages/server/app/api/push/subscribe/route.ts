import { NextResponse } from "next/server";
import { getWebPushService } from "../../../../lib/web-push-service.mjs";
import { ensurePushHook } from "../../../../lib/push-hook";

interface PushSubscriptionBody {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown };
}

export async function POST(request: Request) {
  try {
    ensurePushHook();
    const body = await request.json() as PushSubscriptionBody;
    const deviceId = request.headers.get("x-agentroam-device-id");
    const result = getWebPushService().saveSubscription(deviceId, {
      endpoint: body?.endpoint,
      keys: { p256dh: body?.keys?.p256dh, auth: body?.keys?.auth },
    });
    return NextResponse.json(result);
  } catch (error) {
    const status = (error as { status?: number })?.status;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to save push subscription" },
      { status: status && status >= 400 && status < 500 ? status : 500 },
    );
  }
}
