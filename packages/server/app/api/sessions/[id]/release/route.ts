import { NextResponse } from "next/server";
import {
  getNativeRuntimeService,
  isNativeSessionId,
  runtimeErrorStatus,
} from "../../../../../lib/native-runtime-service";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (!isNativeSessionId(params.id) || !params.id.startsWith("runtime:codex:")) {
    return NextResponse.json({ error: "Only Codex sessions can be released" }, { status: 405 });
  }
  try {
    await getNativeRuntimeService().release(params.id);
    return NextResponse.json({ status: "released" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Codex release failed" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
