import { NextResponse } from "next/server";
import { MCPManager } from "@agent/core";
import type { MCPServerConfig } from "@agent/core";
import { businessCatalog } from "../../../../lib/business-catalog";



export async function POST(request: Request) {
  try {
    const body = await request.json() as MCPServerConfig;
    if (!body.id || !body.command) {
      return NextResponse.json(
        { error: "id and command are required" },
        { status: 400 },
      );
    }
    const manager = new MCPManager();
    try {
      await manager.connectServer(body);
      const tools = await manager.discoverAllTools();
      await businessCatalog().mcp.save(body);
      await businessCatalog().mcp.setEnabled(body.id, true);
      return NextResponse.json({ status: "connected", tools: Object.fromEntries(tools) });
    } finally { await manager.disconnectServer(body.id); }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 },
    );
  }
}
