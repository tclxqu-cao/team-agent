import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../lib/native-runtime-service";
import { getThreadGoalService } from "../../../../lib/thread-goal-service";
import { serverLogger } from "../../../../lib/global-logger";

export async function POST(request: Request) {
  let sessionId: string | undefined;
  let expectedRunId: string | undefined;
  let trigger: "button" | "keyboard" | "api" = "api";
  try {
    const body = await request.json() as { sessionId?: unknown; expectedRunId?: unknown; trigger?: unknown } | null;
    if (!body || Array.isArray(body) || typeof body !== "object"
      || (body.sessionId !== undefined && typeof body.sessionId !== "string")
      || (body.expectedRunId !== undefined && typeof body.expectedRunId !== "string")) {
      return NextResponse.json({ error: "Invalid stop target" }, { status: 400 });
    }
    sessionId = body.sessionId;
    expectedRunId = body.expectedRunId;
    if (body.trigger === "button" || body.trigger === "keyboard") trigger = body.trigger;
  } catch {
    // Body is optional — abort without a session targets the active CA run.
  }

  serverLogger().info("agent stop requested", {
    sessionId, expectedRunId, trigger,
    userAgent: request.headers.get("user-agent")?.slice(0, 256),
  });

  if (sessionId && isNativeSessionId(sessionId)) {
    try {
      await getNativeRuntimeService().abort(sessionId, { expectedRunId, source: "web", trigger });
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Abort failed" },
        { status: runtimeErrorStatus(err) },
      );
    }
    return NextResponse.json({ status: "aborted" });
  }

  // turn_aborted 不是 failed：不拦住的话目标模式会在本轮收尾后立刻自动续跑，
  // 用户从 WebApp 发出的中断等于没停。先登记一次性 stop，再中止运行。
  if (sessionId) getThreadGoalService().requestStop(sessionId);
  agentHost.abort(sessionId);
  return NextResponse.json({ status: "aborted" });
}
