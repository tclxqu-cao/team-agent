import { NextResponse } from "next/server";
import { MCPManager } from "@agent/core";

const mcpManager = new MCPManager();

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const serverId = url.searchParams.get("serverId");
  if (!serverId) {
    return NextResponse.json({ error: "serverId is required" }, { status: 400 });
  }
  await mcpManager.disconnectServer(serverId);
  return NextResponse.json({ status: "disconnected" });
}
