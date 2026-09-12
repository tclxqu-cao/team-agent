import { NextResponse } from "next/server";
import { getUpdateService } from "../../../../lib/update-service";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    if (isCrossSite(request)) return NextResponse.json({ error: "cross-site update request rejected" }, { status: 403 });
    const text = await request.text();
    if (text && text !== "{}") return NextResponse.json({ error: "update install does not accept parameters" }, { status: 400 });
    return NextResponse.json(await getUpdateService().installAvailable(), { status: 202 });
  } catch (error) {
    const status = Number((error as { status?: unknown }).status) || 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "unable to start update" }, { status });
  }
}

const NATIVE_SHELL_ORIGINS = new Set(["capacitor://localhost", "ionic://localhost"]);
function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && NATIVE_SHELL_ORIGINS.has(origin)) return false;
  if (request.headers.get("sec-fetch-site") === "cross-site") return true;
  return Boolean(origin && origin !== new URL(request.url).origin);
}
