import { NextResponse } from "next/server";
import { MCPManager } from "@agent/core";
import type { MCPServerConfig } from "@agent/core";
import { agentHost } from "../../agent-host";

const mcpManager = new MCPManager(agentHost.getBuilder().getToolRegistry());

export async function POST(request: Request) {
  try {
    const body = await request.json() as MCPServerConfig;
    if (!body.id || !body.command) {
      return NextResponse.json(
        { error: "id and command are required" },
        { status: 400 },
      );
    }
    await mcpManager.connectServer(body);
    const tools = await mcpManager.discoverAllTools();
    return NextResponse.json({ status: "connected", tools: Object.fromEntries(tools) });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Connection failed" },
      { status: 500 },
    );
  }
}
