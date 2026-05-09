import { NextResponse } from "next/server";
import { agentHost } from "../agent-host";

export async function GET() {
  const tools = agentHost.getBuilder().getToolRegistry().getAll();
  return NextResponse.json(
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  );
}
