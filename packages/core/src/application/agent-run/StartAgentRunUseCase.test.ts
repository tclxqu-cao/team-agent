import { describe, expect, it, vi } from "vitest";
import { InMemorySessionStore } from "../../domain/session/SessionStore.js";
import type { AgentDefinition } from "../../domain/agent/entities.js";
import type { SkillDefinition } from "../../domain/skill/entities.js";
import {
  AgentRunError,
  StartAgentRunUseCase,
  type AgentRunCatalog,
  type AgentRunRuntime,
} from "./StartAgentRunUseCase.js";

const skill: SkillDefinition = {
  name: "configured-skill",
  description: "Configured behavior",
  triggers: ["/configured"],
  filePath: "",
  source: "custom",
  prompt: "Return configured output",
};
const agent: AgentDefinition = {
  id: "configured-agent",
  name: "Configured Agent",
  description: "Runtime-configured behavior",
  systemPrompt: "Use configured capabilities",
  contextPlaceholders: [],
  capabilities: {
    profileId: "aihub-deepseek",
    enabledTools: ["skill_load", "read_file"],
    enabledSkills: [skill.name],
    enabledMCPServers: [],
  },
  maxIterations: 6,
  isDefault: false,
  created: "2026-09-23T00:00:00.000Z",
  updated: "2026-09-23T00:00:00.000Z",
};

const toolPolicy = {
  id: "readonly",
  name: "Read only",
  enabled: true,
  allowedTools: ["skill_load", "read_file"],
  filesystem: { readRoots: ["/tmp"], writeRoots: [], followSymlinks: false },
  commands: { mode: "deny" as const, programs: [], inheritedEnvironment: [] },
  network: "deny" as const,
  limits: { timeoutMs: 5_000, maxOutputBytes: 4_096 },
};

function fixture(overrides: Partial<AgentRunCatalog> = {}) {
  const sessions = new InMemorySessionStore();
  const catalog: AgentRunCatalog = {
    getAgent: async (id) => id === agent.id ? agent : null,
    getSkill: async (name) => name === skill.name ? skill : null,
    hasModelProfile: (id) => id === "aihub-deepseek",
    ...overrides,
  };
  const start = vi.fn<AgentRunRuntime["start"]>(async (run) => ({
    sessionId: run.sessionId,
    runId: "run-1",
    streamRef: `/api/agent/stream?sessionId=${run.sessionId}`,
  }));
  const useCase = new StartAgentRunUseCase(sessions, catalog, { start }, () => "session-1", () => "2026-09-23T00:00:00.000Z");
  return { sessions, start, useCase };
}

describe("StartAgentRunUseCase", () => {
  it("validates then creates a persistent session and starts the selected run", async () => {
    const { sessions, start, useCase } = fixture();
    const result = await useCase.execute({
      message: "/configured",
      agentId: agent.id,
      skillName: skill.name,
      modelProfileId: "aihub-deepseek",
      context: { intent: "configured" },
      session: { projectId: "configured-project", title: "Configured run", metadata: { callerId: "test-flow" } },
      source: "flow-studio",
    });

    expect(result).toMatchObject({ sessionId: "session-1", runId: "run-1" });
    await expect(sessions.get("session-1")).resolves.toMatchObject({
      projectId: "configured-project",
      title: "Configured run",
      metadata: {
        source: "flow-studio",
        callerId: "test-flow",
        agentId: agent.id,
        skillName: skill.name,
        modelProfileId: "aihub-deepseek",
      },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      message: "/configured",
      agent,
      skill,
      context: { intent: "configured" },
    }));
  });

  it("rejects an unbound skill before creating a session", async () => {
    const other = { ...skill, name: "unconfigured-skill" };
    const { sessions, start, useCase } = fixture({ getSkill: async () => other });
    await expect(useCase.execute({
      message: "private",
      agentId: agent.id,
      skillName: other.name,
      source: "flow-studio",
    })).rejects.toMatchObject({ code: "SKILL_NOT_ALLOWED" } satisfies Partial<AgentRunError>);
    await expect(sessions.list()).resolves.toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });

  it("requires an Agent for explicit Skill selection", async () => {
    const { sessions, useCase } = fixture();
    await expect(useCase.execute({ message: "/configured", skillName: skill.name, source: "sdk" }))
      .rejects.toMatchObject({ code: "INVALID_RUN_REQUEST" } satisfies Partial<AgentRunError>);
    await expect(sessions.list()).resolves.toEqual([]);
  });

  it("reuses an existing session and merges source metadata", async () => {
    const { sessions, useCase } = fixture();
    await sessions.create({
      id: "existing", projectId: "p", title: "Existing", status: "idle", messages: [], events: [],
      created: "2026-09-22T00:00:00.000Z", updated: "2026-09-22T00:00:00.000Z", metadata: { kept: true },
    });
    await useCase.execute({ message: "hello", sessionId: "existing", source: "webapp" });
    await expect(sessions.get("existing")).resolves.toMatchObject({ metadata: { kept: true, source: "webapp" } });
  });

  it("rejects an unknown model profile before creating a session", async () => {
    const { sessions, useCase } = fixture();
    await expect(useCase.execute({ message: "hello", modelProfileId: "missing", source: "sdk" }))
      .rejects.toMatchObject({ code: "MODEL_PROFILE_NOT_FOUND" } satisfies Partial<AgentRunError>);
    await expect(sessions.list()).resolves.toEqual([]);
  });

  it("resolves an enabled tool policy before creating the session", async () => {
    const { sessions, start, useCase } = fixture({
      getToolExecutionPolicy: async (id) => id === toolPolicy.id ? toolPolicy : null,
    });

    await useCase.execute({
      message: "read configured data",
      capabilities: { toolPolicyId: toolPolicy.id },
      source: "flow-studio",
    });

    await expect(sessions.get("session-1")).resolves.toMatchObject({
      metadata: { toolPolicyId: toolPolicy.id },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      capabilities: { toolPolicyId: toolPolicy.id },
      toolExecutionPolicy: toolPolicy,
    }));
    expect(start.mock.calls[0]?.[0].toolExecutionPolicy).not.toBe(toolPolicy);
  });

  it.each([
    ["missing", null, "TOOL_POLICY_NOT_FOUND"],
    ["disabled", { ...toolPolicy, enabled: false }, "TOOL_POLICY_DISABLED"],
  ])("rejects a %s policy before creating a session", async (_label, resolved, code) => {
    const { sessions, start, useCase } = fixture({
      getToolExecutionPolicy: async () => resolved,
    });

    await expect(useCase.execute({
      message: "read configured data",
      capabilities: { toolPolicyId: "selected-policy" },
      source: "flow-studio",
    })).rejects.toMatchObject({ code });
    await expect(sessions.list()).resolves.toEqual([]);
    expect(start).not.toHaveBeenCalled();
  });
});
