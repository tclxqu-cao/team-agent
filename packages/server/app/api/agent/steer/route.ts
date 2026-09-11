import { getCustomerGoalCoordinator } from "../../../../lib/customer-goal-service";
import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../lib/native-runtime-service";

export async function POST(request: Request) {
  try {
    const body = await request.json() as { input?: string; sessionId?: string; messageId?: string };
    if (!body.sessionId || (!body.input && !body.messageId)) {
      return NextResponse.json({ error: "sessionId and input or messageId are required" }, { status: 400 });
    }
    if (isNativeSessionId(body.sessionId)) {
      if (body.messageId) {
        return NextResponse.json(await getNativeRuntimeService().steerMessage(body.sessionId, body.messageId));
      }
      if (!body.input) {
        return NextResponse.json({ error: "input is required" }, { status: 400 });
      }
      const steered = await getNativeRuntimeService().steer(body.sessionId, body.input);
      return NextResponse.json({ steered });
    }
    if (body.messageId) return NextResponse.json({ steered: true, state: await getCustomerGoalCoordinator().steer(body.sessionId, body.messageId) });
    if (!body.input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
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
