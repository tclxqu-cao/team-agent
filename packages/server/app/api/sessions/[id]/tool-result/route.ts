import { NextResponse } from "next/server";
import { getNativeRuntimeService, isNativeSessionId, runtimeErrorStatus } from "../../../../../lib/native-runtime-service";

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!isNativeSessionId(params.id)) {
    return NextResponse.json(
      { error: "Session tool results are available only for native sessions", code: "OPERATION_NOT_SUPPORTED" },
      { status: 405 },
    );
  }
  const url = new URL(request.url);
  const turnId = url.searchParams.get("turnId")?.trim();
  const itemId = url.searchParams.get("itemId")?.trim();
  const revision = url.searchParams.get("revision")?.trim();
  if (!turnId || !itemId || !revision) {
    return NextResponse.json(
      { error: "turnId, itemId, and revision are required", code: "INVALID_SESSION_ID" },
      { status: 400 },
    );
  }
  try {
    const result = await getNativeRuntimeService().getSessionToolResult(params.id, {
      turnId,
      itemId,
      revision,
    });
    return NextResponse.json(result);
  } catch (error) {
    const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : undefined;
    const status = runtimeErrorStatus(error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unable to load tool result",
        ...(code ? { code } : {}),
      },
      { status },
    );
  }
}
