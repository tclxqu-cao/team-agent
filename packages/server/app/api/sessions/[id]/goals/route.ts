import { NextResponse } from "next/server";
import type { SessionMessagePayload } from "@agent/core";
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
    const body = await request.json() as {
      objective?: unknown;
      sourceMessageId?: unknown;
      kind?: unknown;
      messagePayload?: unknown;
    };
    if (typeof body.objective !== "string" || !body.objective.trim()) {
      return NextResponse.json({ error: "objective is required" }, { status: 400 });
    }
    if (isNativeSessionId(params.id)) {
      const result = body.kind === "message"
        ? await getNativeRuntimeService().enqueueMessage(
            params.id,
            {
              sourceMessageId: typeof body.sourceMessageId === "string"
                ? body.sourceMessageId
                : crypto.randomUUID(),
              content: body.objective,
              messagePayload: normalizeMessagePayload(body.messagePayload),
            },
            "web",
          )
        : await getNativeRuntimeService().enqueueGoal(
            params.id,
            body.objective,
            typeof body.sourceMessageId === "string" ? body.sourceMessageId : undefined,
            "web",
          );
      return NextResponse.json(result);
    }
    if (body.kind === "message") {
      return NextResponse.json({ error: "Durable message queue is only available for native sessions" }, { status: 400 });
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
    const body = await request.json() as {
      orderedIds?: unknown;
      kind?: unknown;
      messageId?: unknown;
      objective?: unknown;
      messagePayload?: unknown;
    };
    if (body.kind === "message" && typeof body.messageId === "string") {
      if (!isNativeSessionId(params.id)) {
        return NextResponse.json({ error: "Durable message queue is only available for native sessions" }, { status: 400 });
      }
      if (typeof body.objective !== "string" || !body.objective.trim()) {
        return NextResponse.json({ error: "objective is required" }, { status: 400 });
      }
      return NextResponse.json(await getNativeRuntimeService().updateMessage(
        params.id,
        body.messageId,
        body.objective,
        normalizeMessagePayload(body.messagePayload),
      ));
    }
    if (!Array.isArray(body.orderedIds) || !body.orderedIds.every((id) => typeof id === "string")) {
      return NextResponse.json({ error: "orderedIds must be a string array" }, { status: 400 });
    }
    const state = isNativeSessionId(params.id)
      ? body.kind === "message"
        ? await getNativeRuntimeService().reorderMessages(params.id, body.orderedIds)
        : await getNativeRuntimeService().reorderGoals(params.id, body.orderedIds)
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
    const url = new URL(request.url);
    const goalId = url.searchParams.get("goalId");
    if (!goalId) return NextResponse.json({ error: "goalId is required" }, { status: 400 });
    const state = isNativeSessionId(params.id)
      ? url.searchParams.get("kind") === "message"
        ? await getNativeRuntimeService().cancelMessage(params.id, goalId)
        : await getNativeRuntimeService().cancelGoal(params.id, goalId)
      : await getCustomerGoalCoordinator().cancel(params.id, goalId);
    return NextResponse.json(state);
  } catch (error) {
    return goalError(error);
  }
}

function normalizeMessagePayload(value: unknown): SessionMessagePayload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const payload = value as Record<string, unknown>;
  const images = Array.isArray(payload.images) && payload.images.every((entry) => typeof entry === "string")
    ? payload.images as string[]
    : undefined;
  const agentIds = Array.isArray(payload.agentIds) && payload.agentIds.every((entry) => typeof entry === "string")
    ? payload.agentIds as string[]
    : undefined;
  return {
    ...(images?.length ? { images } : {}),
    ...(agentIds?.length ? { agentIds } : {}),
    ...(typeof payload.agentName === "string" && payload.agentName ? { agentName: payload.agentName } : {}),
  };
}

function goalError(error: unknown) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Goal operation failed" },
    { status: runtimeErrorStatus(error) },
  );
}
