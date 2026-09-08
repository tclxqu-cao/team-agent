import { NextResponse } from "next/server";
import { getUpdateService } from "../../../../lib/update-service";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(await getUpdateService().status(), { headers: { "cache-control": "no-store" } });
}
