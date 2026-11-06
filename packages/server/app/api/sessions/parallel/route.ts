import { NextResponse } from "next/server";
import { parallelAgentTypes } from "@agent/core";
import { createParallelSessionGroup, getParallelSessionGroup } from "../../../../lib/parallel-sessions";

export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!sessionId) return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
  return NextResponse.json(getParallelSessionGroup(sessionId));
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const agentTypes = parallelAgentTypes(body.agentTypes);
    if (typeof body.cwd !== "string" || !body.cwd.trim()) throw new Error("请先选择会话目录");
    return NextResponse.json(await createParallelSessionGroup({
      agentTypes, cwd: body.cwd, title: typeof body.title === "string" ? body.title.slice(0, 200) : "新会话",
    }), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "创建多 Agent 会话失败" }, { status: 400 });
  }
}
