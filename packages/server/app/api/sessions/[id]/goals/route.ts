import { NextResponse } from "next/server";
import { getCustomerGoalCoordinator } from "../../../../../lib/customer-goal-service";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../../lib/native-runtime-service";

export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const state = isNativeSessionId(params.id)
      ? await getNativeRuntimeService().getGoals(params.id, "web")
      : await getCustomerGoalCoordinator().get(params.id);
    return NextResponse.json(state);
  } catch (error) {
    return goalError(error);
  }
}

export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const body = await request.json() as { objective?: unknown; sourceMessageId?: unknown };
    if (typeof body.objective !== "string" || !body.objective.trim()) {
      return NextResponse.json({ error: "objective is required" }, { status: 400 });
    }
    if (isNativeSessionId(params.id)) {
      const result = await getNativeRuntimeService().enqueueGoal(
        params.id,
        body.objective,
        typeof body.sourceMessageId === "string" ? body.sourceMessageId : undefined,
        "web",
      );
      return NextResponse.json(result);
    }
    const state = await getCustomerGoalCoordinator().enqueue(
      params.id,
      body.objective,
      typeof body.sourceMessageId === "string" ? body.sourceMessageId : undefined,
    );
    return NextResponse.json({ state });
  } catch (error) {
    return goalError(error);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const body = await request.json() as { orderedIds?: unknown };
    if (!Array.isArray(body.orderedIds) || !body.orderedIds.every((id) => typeof id === "string")) {
      return NextResponse.json({ error: "orderedIds must be a string array" }, { status: 400 });
    }
    const state = isNativeSessionId(params.id)
      ? await getNativeRuntimeService().reorderGoals(params.id, body.orderedIds)
      : await getCustomerGoalCoordinator().reorder(params.id, body.orderedIds);
    return NextResponse.json(state);
  } catch (error) {
    return goalError(error);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const goalId = new URL(request.url).searchParams.get("goalId");
    if (!goalId) return NextResponse.json({ error: "goalId is required" }, { status: 400 });
    const state = isNativeSessionId(params.id)
      ? await getNativeRuntimeService().cancelGoal(params.id, goalId)
      : await getCustomerGoalCoordinator().cancel(params.id, goalId);
    return NextResponse.json(state);
  } catch (error) {
    return goalError(error);
  }
}

function goalError(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Goal operation failed" },
    { status: runtimeErrorStatus(error) },
  );
}
