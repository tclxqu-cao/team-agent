import { NextResponse } from "next/server";
import {
  getNativeRuntimeService,
  runtimeErrorStatus,
} from "../../../../../lib/native-runtime-service";

export async function POST(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const forked = await getNativeRuntimeService().fork(params.id);
    return NextResponse.json(forked, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
