import { NextResponse } from "next/server";
import { getThreadGoalService } from "../../../../../lib/thread-goal-service";
import { isNativeSessionId } from "../../../../../lib/native-runtime-service";

// 目标模式（thread goal）API：GET 查看 / PUT 设置 / PATCH 暂停恢复 / DELETE 清除。
// 目标持久化在 thread_goals 表；续跑由 AgentHost 空闲钩子驱动，无需客户端轮询触发。

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    return NextResponse.json({ error: "Thread goal is only available on customer-agent sessions" }, { status: 400 });
  }
  const goal = await getThreadGoalService().getGoal(params.id);
  return NextResponse.json({ goal });
}

export async function PUT(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    return NextResponse.json({ error: "Thread goal is only available on customer-agent sessions" }, { status: 400 });
  }
  try {
    const body = await request.json() as { objective?: unknown; tokenBudget?: unknown };
    if (typeof body.objective !== "string" || !body.objective.trim()) {
      return NextResponse.json({ error: "objective is required" }, { status: 400 });
    }
    const tokenBudget = body.tokenBudget === null || body.tokenBudget === undefined
      ? undefined
      : Number(body.tokenBudget);
    if (tokenBudget !== undefined && (!Number.isFinite(tokenBudget) || tokenBudget <= 0)) {
      return NextResponse.json({ error: "tokenBudget must be a positive number or null" }, { status: 400 });
    }
    const goal = await getThreadGoalService().setGoal(params.id, body.objective, {
      tokenBudget: tokenBudget ?? null,
    });
    return NextResponse.json({ goal });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to set thread goal" },
      { status: errorStatus(error) },
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    return NextResponse.json({ error: "Thread goal is only available on customer-agent sessions" }, { status: 400 });
  }
  try {
    const body = await request.json() as { action?: unknown };
    const service = getThreadGoalService();
    if (body.action === "pause") return NextResponse.json({ goal: await service.pauseGoal(params.id) });
    if (body.action === "resume") return NextResponse.json({ goal: await service.resumeGoal(params.id) });
    return NextResponse.json({ error: "action must be 'pause' or 'resume'" }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update thread goal" },
      { status: errorStatus(error) },
    );
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (isNativeSessionId(params.id)) {
    return NextResponse.json({ error: "Thread goal is only available on customer-agent sessions" }, { status: 400 });
  }
  const cleared = await getThreadGoalService().clearGoal(params.id);
  return NextResponse.json({ cleared });
}

function errorStatus(error: unknown): 400 | 404 | 409 {
  const message = error instanceof Error ? error.message : "";
  if (/no thread goal|Cannot transition/.test(message)) return 409;
  if (/required|must be|at most/i.test(message)) return 400;
  return 400;
}
