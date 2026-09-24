import { StartAgentRunUseCase } from "@agent/core";
import { agentHost, CustomerAgentRunConflictError } from "../../../agent-host";
import { businessCatalog } from "../../../../../lib/business-catalog";
import {
  assertFlowAuthorized,
  flowErrorResponse,
  parseFlowRunRequest,
  registerFlowRun,
  validateFlowRunRequest,
} from "../../../../../lib/flow-protocol";
import { sharedSettings } from "../../../../../lib/shared-settings";
import { toolExecutionPolicies } from "../../../../../lib/tool-execution-policies";

export async function POST(request: Request) {
  try {
    assertFlowAuthorized(request);
    const body = parseFlowRunRequest(await request.json());
    await validateFlowRunRequest(body);
    const catalog = businessCatalog();
    const useCase = new StartAgentRunUseCase(agentHost.getSessionStore(), {
      getAgent: (id) => catalog.agents.get(id),
      getSkill: (name) => catalog.skills.get(name),
      hasModelProfile: (id) => sharedSettings().read().profiles.some((profile) => profile.id === id),
      getToolExecutionPolicy: (id) => toolExecutionPolicies().get(id),
    }, {
      assertAvailable: (sessionId) => {
        if (agentHost.isSessionRunning(sessionId)) throw new CustomerAgentRunConflictError(sessionId);
      },
      start: (run) => {
        const admitted = agentHost.startRun(run.message, run.sessionId, run.images, {
          ...(run.modelProfileId ? { profileId: run.modelProfileId } : {}),
          agentIds: run.agent ? [run.agent.id] : [],
          enabledTools: run.capabilities.enabledTools,
          enabledSkills: run.capabilities.enabledSkills,
          activatedSkills: run.capabilities.activatedSkills,
          enabledMCPServers: run.capabilities.enabledMCPServers,
          memoryEnabled: run.capabilities.memoryEnabled,
          toolExecutionPolicy: run.toolExecutionPolicy,
          instructions: body.instructions,
          ...(Object.keys(run.context).length ? { context: run.context } : {}),
        });
        admitted.completion.catch(() => undefined);
        return {
          sessionId: run.sessionId,
          runId: admitted.runId,
          streamRef: `/api/flow/v1/runs/${admitted.runId}/events`,
        };
      },
    });
    const selection = body.selection;
    const started = await useCase.execute({
      message: body.input,
      ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      ...(body.agentId ? { agentId: body.agentId } : {}),
      ...(selection.modelId ? { modelProfileId: selection.modelId } : {}),
      context: body.context,
      capabilities: {
        enabledTools: selection.toolIds,
        enabledSkills: selection.skillIds,
        activatedSkills: selection.activatedSkillIds,
        enabledMCPServers: selection.mcpServerIds,
        memoryEnabled: selection.memoryEnabled,
        toolPolicyId: selection.toolPolicyId,
      },
      session: {
        title: `Flow: ${body.input.slice(0, 48)}`,
        metadata: { flowProtocolVersion: "1" },
      },
      source: "flow-studio",
    });
    registerFlowRun(started.runId, started.sessionId);
    return Response.json({
      runId: started.runId,
      sessionId: started.sessionId,
      eventsUrl: started.streamRef,
    });
  } catch (error) {
    return flowErrorResponse(error);
  }
}
