import { NextResponse } from "next/server";
import { agentHost } from "../agent-host";

export async function GET() {
  const sessions = await agentHost.getSessionStore().list();
  return NextResponse.json(sessions);
}

export async function POST(request: Request) {
  const body = await request.json() as { title?: string };
  const session = await agentHost.createSession(body.title ?? "Untitled");
  return NextResponse.json(session, { status: 201 });
}
