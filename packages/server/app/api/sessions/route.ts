import { NextResponse } from "next/server";
import { agentHost } from "../agent-host";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || undefined;
  const sessions = await agentHost.getSessionStore().list(projectId);
  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const body = await request.json() as { title?: string; projectId?: string };
  const session = await agentHost.createSession(body.title ?? "Untitled", body.projectId ?? "");
  return NextResponse.json(session, { status: 201 });
}
