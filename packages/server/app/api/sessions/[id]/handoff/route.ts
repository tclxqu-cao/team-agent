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
  if (!isNativeSessionId(params.id)) {
    return NextResponse.json({ error: "Only native sessions can be handed off" }, { status: 405 });
  }
  try {
    const snapshot = await getNativeRuntimeService().handoff(params.id, "desktop");
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Native handoff failed" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
