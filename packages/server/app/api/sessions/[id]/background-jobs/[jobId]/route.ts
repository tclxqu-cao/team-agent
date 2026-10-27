import { NextResponse } from "next/server";
import { getNativeRuntimeService, isNativeSessionId, runtimeErrorStatus } from "../../../../../../lib/native-runtime-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string; jobId: string } }) {
  if (!isNativeSessionId(params.id) || !params.jobId.trim()) return NextResponse.json({ error: "后台任务标识无效" }, { status: 400 });
  try {
    return NextResponse.json(await getNativeRuntimeService().getBackgroundJobOutput(params.id, params.jobId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "后台任务输出读取失败" }, { status: runtimeErrorStatus(error) });
  }
}
