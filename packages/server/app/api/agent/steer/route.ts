import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../lib/native-runtime-service";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { input: string; sessionId?: string };
    if (!body.input || !body.sessionId) {
      return NextResponse.json({ error: "input and sessionId are required" }, { status: 400 });
    }
    if (isNativeSessionId(body.sessionId)) {
      const steered = await getNativeRuntimeService().steer(body.sessionId, body.input);
      return NextResponse.json({ steered });
    }
    const steered = await agentHost.steer(body.input, body.sessionId);
    return NextResponse.json({ steered });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: runtimeErrorStatus(err) },
    );
  }
}
