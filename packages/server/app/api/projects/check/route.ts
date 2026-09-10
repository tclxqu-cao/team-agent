import { NextResponse } from "next/server";
import { webProjectService } from "../project-http";

export async function GET(request: Request) {
  const path = new URL(request.url).searchParams.get("path") ?? "";
  return NextResponse.json({ valid: webProjectService.check(path) }, {
    headers: { "Cache-Control": "no-store" },
  });
}
