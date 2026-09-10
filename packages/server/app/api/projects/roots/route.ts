import { NextResponse } from "next/server";
import { webProjectService } from "../project-http";

export async function GET() {
  return NextResponse.json(webProjectService.roots(), {
    headers: { "Cache-Control": "no-store" },
  });
}
