import { NextResponse } from "next/server";
import { businessCatalog } from "../../../../lib/business-catalog";


export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const serverId = url.searchParams.get("serverId");
  if (!serverId) {
    return NextResponse.json({ error: "serverId is required" }, { status: 400 });
  }
  await businessCatalog().mcp.setEnabled(serverId, false);
  return NextResponse.json({ status: "disconnected" });
}
