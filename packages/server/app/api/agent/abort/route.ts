import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../lib/native-runtime-service";
import { getThreadGoalService } from "../../../../lib/thread-goal-service";

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

  // turn_aborted 不是 failed：不拦住的话目标模式会在本轮收尾后立刻自动续跑，
  // 用户从 WebApp 发出的中断等于没停。先登记一次性 stop，再中止运行。
  if (sessionId) getThreadGoalService().requestStop(sessionId);
  agentHost.abort(sessionId);
  return NextResponse.json({ status: "aborted" });
}
