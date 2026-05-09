import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  const session = await agentHost.getSessionStore().get(params.id);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  return NextResponse.json(session);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  await agentHost.getSessionStore().delete(params.id);
  return NextResponse.json({ status: "deleted" });
}
