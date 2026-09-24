import { NextResponse } from "next/server";
import { AgentRunError, StartAgentRunUseCase, type AgentEvent, type AgentRunSource, type SkillDefinition } from "@agent/core";
import { RuntimeSessionError } from "@agent/native-runtime";
import { agentHost, CustomerAgentRunConflictError } from "../../agent-host";
import {
  getNativeRuntimeService,
  isNativeSessionId,
} from "../../../../lib/native-runtime-service";
import { normalizeCustomerAgentRunOptions } from "./run-options";
import { serverLogger } from "../../../../lib/global-logger";
import { ensurePushHook } from "../../../../lib/push-hook";
import { businessCatalog } from "../../../../lib/business-catalog";
import { sharedSettings } from "../../../../lib/shared-settings";
import { toolExecutionPolicies } from "../../../../lib/tool-execution-policies";

export async function POST(request: Request) {
  try {
    ensurePushHook();
    const body = await request.json() as {
      input: string;
      agentId?: string;
      agentIds?: string[];
      skillName?: string;
      sessionId?: string;
      images?: string[];
      profileId?: string;
      projectId?: string;
      title?: string;
      metadata?: Record<string, unknown>;
      context?: Record<string, unknown>;
      source?: AgentRunSource;
      model?: { provider: string; apiKey: string; modelId: string; baseUrl?: string };
      reasoningEffort?: "off" | "low" | "medium" | "high";
      maxIterations?: number;
      maxTokens?: number;
      toolPolicyId?: string;
      nativeModel?: { id: string; providerID?: string };
      nativeReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
    };

    if (!body.input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }
    if (body.agentIds !== undefined && (!Array.isArray(body.agentIds) || body.agentIds.length > 20 || body.agentIds.some((id) => typeof id !== "string" || !id.trim()))) {
      return NextResponse.json({ error: "agentIds must contain at most 20 non-empty IDs" }, { status: 400 });
    }
    if (body.agentId !== undefined && body.agentIds !== undefined) {
      return NextResponse.json({ error: "agentId and agentIds are mutually exclusive" }, { status: 400 });
    }
    if (body.profileId !== undefined && (typeof body.profileId !== "string" || !body.profileId.trim() || body.profileId.length > 200)) {
      return NextResponse.json({ error: "profileId must be a non-empty string" }, { status: 400 });
    }

    if (body.sessionId && isNativeSessionId(body.sessionId)) {
      const sessionId = body.sessionId;
      const service = getNativeRuntimeService();
      // Reserve the broker run before replacing any replay state. A rejected
      // duplicate send must leave the live turn and the renderer draft intact.
      const admission = await service.startRun(sessionId, body.input, body.images, "web", {
        ...(body.nativeModel?.id ? { model: body.nativeModel } : {}),
        ...(body.nativeReasoningEffort ? { reasoningEffort: body.nativeReasoningEffort } : {}),
      });
      agentHost.resetExternalStream(sessionId);
      agentHost.publishExternal(sessionId, {
        type: "run_admitted",
        _nativeRunId: admission.runId,
        _nativeSequence: admission.snapshotRevision,
      } as unknown as AgentEvent);
      let unsubscribe: (() => void) | null = null;
      let terminalSeen = false;
      void service.subscribe(sessionId, 0, ({ event }) => {
        agentHost.publishExternal(sessionId, event);
        if (event.type === "done" || event.type === "error") {
          terminalSeen = true;
          unsubscribe?.();
        }
      }).then((stop) => {
        unsubscribe = stop;
        if (terminalSeen) stop();
      }).catch((err) => {
        const code = err instanceof RuntimeSessionError ? err.code : undefined;
        serverLogger().error("native run subscription failed", err, { sessionId, code });
        agentHost.publishExternal(sessionId, {
          type: "error",
          message: err instanceof Error ? err.message : "Native run subscription failed",
          ...(code ? { code } : {}),
        } as AgentEvent);
      });
      return NextResponse.json({
        sessionId,
        streamUrl: `/api/agent/stream?sessionId=${sessionId}`,
        runId: admission.runId,
        snapshotRevision: admission.snapshotRevision,
      });
    }

    const sessionStore = agentHost.getSessionStore();
    const limits = normalizeCustomerAgentRunOptions(body);
    const selectedAgentId = body.agentId ?? (body.agentIds?.length === 1 ? body.agentIds[0] : undefined);
    const catalog = businessCatalog();
    const useCase = new StartAgentRunUseCase(sessionStore, {
      getAgent: (id) => catalog.agents.get(id),
      getSkill: async (name) => catalog.skills.get(name)
        ?? (await catalog.call("listSkills", []) as SkillDefinition[]).find((skill) => skill.name === name)
        ?? null,
      hasModelProfile: (id) => sharedSettings().read().profiles.some((profile) => profile.id === id),
      getToolExecutionPolicy: (id) => toolExecutionPolicies().get(id),
    }, {
      assertAvailable: (sessionId) => {
        if (agentHost.isSessionRunning(sessionId)) throw new CustomerAgentRunConflictError(sessionId);
      },
      start: (run) => {
        // Browser/Desktop use persisted settings. Explicit SDK overrides remain
        // scoped to this run instead of mutating a shared builder.
        const admitted = agentHost.startRun(run.message, run.sessionId, run.images, {
          ...(body.model ? { model: body.model } : {}),
          ...(run.modelProfileId ? { profileId: run.modelProfileId } : {}),
          ...(body.reasoningEffort ? { reasoningEffort: body.reasoningEffort } : {}),
          ...(body.maxIterations === undefined ? {} : { maxIterations: limits.maxIterations }),
          ...(body.maxTokens === undefined ? {} : { maxTokens: limits.maxTokens }),
          ...(body.agentIds ? { agentIds: body.agentIds } : run.agent ? { agentIds: [run.agent.id] } : {}),
          ...(run.skill ? { activatedSkills: [run.skill.name] } : {}),
          ...(Object.keys(run.context).length ? { context: run.context } : {}),
          toolExecutionPolicy: run.toolExecutionPolicy,
        });
        admitted.completion.catch((err) => {
          serverLogger().error("agent run error", err, { sessionId: run.sessionId });
          console.error("Agent run error:", err);
        });
        return {
          sessionId: run.sessionId,
          runId: admitted.runId,
          streamRef: `/api/agent/stream?sessionId=${run.sessionId}`,
        };
      },
    });
    const started = await useCase.execute({
      message: body.input,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
      ...(body.skillName ? { skillName: body.skillName } : {}),
      ...(body.profileId ? { modelProfileId: body.profileId } : {}),
      ...(body.images?.length ? { images: body.images } : {}),
      ...(body.context ? { context: body.context } : {}),
      ...(body.toolPolicyId ? { capabilities: { toolPolicyId: body.toolPolicyId } } : {}),
      session: {
        ...(body.projectId ? { projectId: body.projectId } : {}),
        ...(body.title ? { title: body.title } : {}),
        ...(body.metadata ? { metadata: body.metadata } : {}),
      },
      source: body.source ?? "webapp",
    });

    return NextResponse.json({
      sessionId: started.sessionId,
      streamUrl: started.streamRef,
      runId: started.runId,
    });
  } catch (err) {
    serverLogger().error("agent run request failed", err, { status: err instanceof RuntimeSessionError ? err.code : undefined });
    const code = err instanceof RuntimeSessionError ? err.code : undefined;
    const customerAgentCode = err instanceof CustomerAgentRunConflictError ? err.code : undefined;
    const applicationCode = err instanceof AgentRunError ? err.code : undefined;
    const resolvedCode = code ?? customerAgentCode ?? applicationCode;
    const isConflict = resolvedCode === "SESSION_OCCUPIED" || resolvedCode === "SESSION_ALREADY_RUNNING";
    const applicationStatus = applicationCode === "AGENT_NOT_FOUND"
      || applicationCode === "SKILL_NOT_FOUND"
      || applicationCode === "MODEL_PROFILE_NOT_FOUND"
      || applicationCode === "TOOL_POLICY_NOT_FOUND"
      ? 404
      : applicationCode === "SKILL_NOT_ALLOWED" || applicationCode === "TOOL_POLICY_DISABLED"
        ? 422
        : applicationCode
          ? 400
          : undefined;
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "Internal error",
        ...(resolvedCode ? { code: resolvedCode } : {}),
      },
      { status: isConflict ? 409 : applicationStatus ?? 500 },
    );
  }
}
