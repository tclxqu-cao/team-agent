import { NextResponse } from "next/server";
import { getUpdateService } from "../../../../lib/update-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (isCrossSite(request)) return NextResponse.json({ error: "cross-site update request rejected" }, { status: 403 });
  return NextResponse.json(getUpdateService().requestCheck(), { status: 202, headers: { "cache-control": "no-store" } });
}

function isCrossSite(request: Request): boolean {
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  const origin = request.headers.get("origin");
  return Boolean(origin && origin !== new URL(request.url).origin);
}
