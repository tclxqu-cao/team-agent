import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";

export async function POST() {
  agentHost.abort();
  return NextResponse.json({ status: "aborted" });
}
