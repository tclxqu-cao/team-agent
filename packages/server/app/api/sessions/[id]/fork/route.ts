import { NextResponse } from "next/server";
import { parseSessionForkPoint, RuntimeSessionError } from "@agent/native-runtime";
import { agentHost } from "../../../agent-host";
import { forkCustomerSession } from "../../../../../lib/session-fork-service";
import {
  getNativeRuntimeService,
  runtimeErrorStatus,
} from "../../../../../lib/native-runtime-service";

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  const id = params.id;
  const requirePoint = new URL(request.url).pathname.endsWith("/fork-at");
  try {
    let body: { point?: unknown };
    try {
      const payload = await request.text();
      body = payload.trim() ? JSON.parse(payload) : {};
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch {
      throw new RuntimeSessionError("Fork 参数格式无效", "INVALID_SESSION_ID");
    }
    const point = requirePoint || body.point !== undefined ? parseSessionForkPoint(body.point) : undefined;
    const forked = point && !id.startsWith("runtime:")
      ? await forkCustomerSession(agentHost.getSessionStore(), id, point, agentHost.isSessionRunning(id))
      : point ? await getNativeRuntimeService().fork(id, point) : await getNativeRuntimeService().fork(id);
    return NextResponse.json(forked, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
