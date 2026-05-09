import { NextResponse } from "next/server";
import { MCPManager } from "@agent/core";

const mcpManager = new MCPManager();

export async function GET() {
  const servers = mcpManager.listServers();
  return NextResponse.json(servers);
}
