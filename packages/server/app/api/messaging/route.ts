import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Retired clients must not restart message collection, dispatch or delivery. */
export function GET() {
  return NextResponse.json({ error: "消息接入功能已移除" }, { status: 410 });
}

export const POST = GET;
