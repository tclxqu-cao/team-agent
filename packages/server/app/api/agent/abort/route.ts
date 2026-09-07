import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../lib/native-runtime-service";

export async function POST(request: Request) {
  let sessionId: string | undefined;
  try {
    sessionId = (await request.json() as { sessionId?: string }).sessionId;
  } catch {
    // Body is optional — abort without a session targets the active CA run.
  }

  if (sessionId && isNativeSessionId(sessionId)) {
    try {
      await getNativeRuntimeService().abort(sessionId);
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Abort failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ status: "aborted" });
  }

  agentHost.abort(sessionId);
  return NextResponse.json({ status: "aborted" });
}
