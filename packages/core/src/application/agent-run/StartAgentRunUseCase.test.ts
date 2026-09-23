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
  name: "portfolio-works",
  description: "Works",
  triggers: ["/works"],
  filePath: "",
  source: "custom",
  prompt: "Return works",
};
const agent: AgentDefinition = {
  id: "portfolio-content-agent",
  name: "Portfolio Content Agent",
  description: "Public portfolio content",
  systemPrompt: "Use public content only",
  contextPlaceholders: [],
  capabilities: {
    profileId: "aihub-deepseek",
    enabledTools: ["skill_load", "public_wiki_query"],
    enabledSkills: [skill.name],
    enabledMCPServers: [],
  },
  maxIterations: 6,
  isDefault: false,
  created: "2026-09-23T00:00:00.000Z",
  updated: "2026-09-23T00:00:00.000Z",
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
      message: "/works",
      agentId: agent.id,
      skillName: skill.name,
      modelProfileId: "aihub-deepseek",
      context: { intent: "works" },
      session: { projectId: "portfolio", title: "Portfolio: works", metadata: { flowId: "homepage-main" } },
      source: "flow-studio",
    });

    expect(result).toMatchObject({ sessionId: "session-1", runId: "run-1" });
    await expect(sessions.get("session-1")).resolves.toMatchObject({
      projectId: "portfolio",
      title: "Portfolio: works",
      metadata: {
        source: "flow-studio",
        flowId: "homepage-main",
        agentId: agent.id,
        skillName: skill.name,
        modelProfileId: "aihub-deepseek",
      },
    });
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      message: "/works",
      agent,
      skill,
      context: { intent: "works" },
    }));
  });

  it("rejects an unbound skill before creating a session", async () => {
    const other = { ...skill, name: "portfolio-private" };
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
    await expect(useCase.execute({ message: "/works", skillName: skill.name, source: "sdk" }))
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
});
