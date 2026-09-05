import { NextResponse } from "next/server";
import { RuntimeSessionError } from "../../../../../desktop/main/agent-runtime/types.js";
import { getNativeRuntimeService, runtimeErrorStatus } from "../../../../lib/native-runtime-service";

export const dynamic = "force-dynamic";

/** Models a native runtime's own connection offers, for the composer model picker. */
export async function GET(request: Request) {
  const agentType = new URL(request.url).searchParams.get("agentType");
  if (agentType !== "codex" && agentType !== "claude-code" && agentType !== "opencode") {
    return NextResponse.json({ error: "agentType must be codex, claude-code or opencode" }, { status: 400 });
  }
  try {
    const models = await getNativeRuntimeService().listModels(agentType);
    return NextResponse.json({ agentType, models });
  } catch (error) {
    if (error instanceof RuntimeSessionError && error.code === "OPERATION_NOT_SUPPORTED") {
      return NextResponse.json({ agentType, models: [], supported: false });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to list models" },
      { status: runtimeErrorStatus(error) },
    );
  }
}
