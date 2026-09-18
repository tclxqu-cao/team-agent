import { NextResponse } from "next/server";
import { getWebPushService } from "../../../../lib/web-push-service.mjs";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { endpoint?: unknown };
    return NextResponse.json(getWebPushService().deleteSubscription(body?.endpoint));
  } catch (error) {
    const status = (error as { status?: number })?.status;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to remove push subscription" },
      { status: status && status >= 400 && status < 500 ? status : 500 },
    );
  }
}
