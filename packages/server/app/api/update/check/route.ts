import { NextResponse } from "next/server";
import { getUpdateService } from "../../../../lib/update-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (isCrossSite(request)) return NextResponse.json({ error: "cross-site update request rejected" }, { status: 403 });
  return NextResponse.json(getUpdateService().requestCheck(), { status: 202, headers: { "cache-control": "no-store" } });
}

const NATIVE_SHELL_ORIGINS = new Set(["capacitor://localhost", "ionic://localhost"]);
function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && NATIVE_SHELL_ORIGINS.has(origin)) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  return Boolean(origin && origin !== new URL(request.url).origin);
}
