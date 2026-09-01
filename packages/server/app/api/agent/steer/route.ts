import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import { isNativeSessionId } from "../../../../lib/native-runtime-service";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { input: string; sessionId?: string };
    if (!body.input || !body.sessionId) {
      return NextResponse.json({ error: "input and sessionId are required" }, { status: 400 });
    }
    if (isNativeSessionId(body.sessionId)) {
      // Native runtimes have no mid-turn steer; the client queues instead.
      return NextResponse.json({ steered: false });
    }
    const steered = await agentHost.steer(body.input, body.sessionId);
    return NextResponse.json({ steered });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
