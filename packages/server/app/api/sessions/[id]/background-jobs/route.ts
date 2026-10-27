import { NextResponse } from "next/server";
import { getNativeRuntimeService, isNativeSessionId, runtimeErrorStatus } from "../../../../../lib/native-runtime-service";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  if (!isNativeSessionId(params.id)) return NextResponse.json({ error: "此会话不支持后台任务管理" }, { status: 400 });
  try {
    return NextResponse.json({ jobs: await getNativeRuntimeService().listBackgroundJobs(params.id) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "后台任务读取失败" }, { status: runtimeErrorStatus(error) });
  }
}
