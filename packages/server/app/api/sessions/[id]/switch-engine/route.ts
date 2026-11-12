import { NextResponse } from "next/server";
import { EngineSwitchError, type AgentType } from "@agent/core";
import { getEngineSwitchContainer } from "../../../../../lib/engine-switch/container";
import { handoffForWire } from "../../../../../lib/engine-switch/wire";

const NATIVE_AGENT_TYPES: readonly AgentType[] = [
  "codex",
  "claude-code",
  "opencode",
  "deepseek-harness",
  "qoder",
  "zcode",
  "workbuddy",
  "copilot",
];

function errorStatus(error: unknown): number {
  if (error instanceof EngineSwitchError) {
    switch (error.code) {
      case "SOURCE_NOT_FOUND":
        return 404;
      case "SESSION_OCCUPIED":
        return 409;
      case "RUNTIME_UNAVAILABLE":
        return 503;
      default:
        return 400;
    }
  }
  return 500;
}

/**
 * POST /api/sessions/[id]/switch-engine
 * Body: { targetAgentType: AgentType, clean?: boolean, budgetTokens?: number, threadKey?: string }
 *
 * Moves this session's logical thread onto `targetAgentType`. The use case
 * materializes an auditable context handoff (delta + resume when the target
 * engine has a prior session in this thread, full + create otherwise); the
 * handoff preamble is injected into the target session's next run.
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const body = await request.json().catch(() => null) as
      | { targetAgentType?: AgentType; clean?: boolean; budgetTokens?: number; threadKey?: string }
      | null;
    const targetAgentType = body?.targetAgentType;
    if (!targetAgentType || typeof targetAgentType !== "string") {
      return NextResponse.json({ error: "targetAgentType is required" }, { status: 400 });
    }
    if (!NATIVE_AGENT_TYPES.includes(targetAgentType)) {
      return NextResponse.json({ error: `Unknown native agent type: ${targetAgentType}` }, { status: 400 });
    }
    if (body?.budgetTokens !== undefined && (!Number.isInteger(body.budgetTokens) || body.budgetTokens < 1_024 || body.budgetTokens > 64_000)) {
      return NextResponse.json({ error: "budgetTokens must be an integer between 1024 and 64000" }, { status: 400 });
    }

    const { useCase } = getEngineSwitchContainer();
    const result = await useCase.execute({
      sourceSessionId: params.id,
      targetAgentType,
      ...(body?.threadKey ? { threadKey: body.threadKey } : {}),
      ...(body?.clean ? { clean: true } : {}),
      ...(body?.budgetTokens !== undefined ? { budgetTokens: body.budgetTokens } : {}),
    });

    return NextResponse.json({
      threadKey: result.thread.threadKey,
      strategy: result.strategy,
      record: result.record,
      handoff: result.handoff ? handoffForWire(result.handoff) : null,
      targetSession: {
        id: result.targetSession.id,
        agentType: result.targetSession.agentType,
        title: result.targetSession.title,
        cwd: result.targetSession.cwd,
        ...(result.targetSession.projectId ? { projectId: result.targetSession.projectId } : {}),
      },
    }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Engine switch failed" },
      { status: errorStatus(error) },
    );
  }
}
