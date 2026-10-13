import { NextResponse } from "next/server";
import { parseNativeGoalMutation } from "@agent/native-runtime";
import { getNativeRuntimeService, isNativeSessionId, runtimeErrorStatus } from "../../../../../lib/native-runtime-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  if (!isNativeSessionId(params.id)) return NextResponse.json({ error: "此会话不支持原生目标" }, { status: 400 });
  try {
    return NextResponse.json({ goal: await getNativeRuntimeService().getNativeGoal(params.id) });
  } catch (error) { return goalError(error); }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!isNativeSessionId(params.id)) return NextResponse.json({ error: "此会话不支持原生目标" }, { status: 400 });
  let mutation;
  try { mutation = parseNativeGoalMutation(await request.json()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "目标操作格式无效" }, { status: 400 }); }
  try {
    return NextResponse.json({ goal: await getNativeRuntimeService().mutateNativeGoal(params.id, mutation) });
  } catch (error) { return goalError(error); }
}

function goalError(error: unknown) {
  return NextResponse.json({ error: error instanceof Error ? error.message : "原生目标操作失败" }, { status: runtimeErrorStatus(error) });
}
