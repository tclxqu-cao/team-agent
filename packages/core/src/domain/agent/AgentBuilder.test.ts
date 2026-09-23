import { describe, it, expect } from "vitest";
import { AgentBuilder } from './AgentBuilder.js';
import type { IModelProvider, StreamEvent } from '../model/entities.js';

function createModel(): IModelProvider {
  return {
    providerId: "mock",
    modelId: "mock-model",
    streamChat: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "text_chunk", text: "done" };
      yield { type: "text_done" };
    },
    countTokens: async () => 10,
    supportsModel: () => true,
  };
}

describe("AgentBuilder", () => {
  it("allows semantic skill matching to be disabled fluently", () => {
    const builder = new AgentBuilder();

    expect(builder.withSemanticSkillMatching(false)).toBe(builder);
    expect(builder.withSkillDiscovery(false)).toBe(builder);
    expect(builder.withActivatedSkills(["portfolio-works"])).toBe(builder);
    expect(builder.withMaxOutputTokens(32_768)).toBe(builder);
  });

  it("propagates the optional output ceiling into the built agent", async () => {
    const loop = await new AgentBuilder()
      .withWorkingDirectory(process.cwd())
      .withModelProvider(createModel())
      .withMaxOutputTokens(32_768)
      .build();

    expect((loop as unknown as { config: { maxOutputTokens?: number } }).config.maxOutputTokens).toBe(32_768);
  });

  it("can omit broad skill discovery while retaining exact skill loading", () => {
    const builder = new AgentBuilder()
      .withWorkingDirectory(process.cwd())
      .withSkillDiscovery(false)
      .withModelProvider(createModel());

    builder.buildSync();

    expect(builder.getToolRegistry().get("skill_discover")).toBeUndefined();
    expect(builder.getToolRegistry().get("skill_load")).toBeDefined();
  });

  it("preserves explicit empty per-run capability policies", async () => {
    const builder = new AgentBuilder()
      .withWorkingDirectory(process.cwd())
      .withExactEnabledTools([])
      .withExactEnabledSkills([])
      .withModelProvider(createModel());

    const loop = await builder.build();
    const config = (loop as unknown as { config: {
      enabledTools: string[] | null;
      enabledSkills: string[] | null;
      allowUnlistedDynamicTools?: boolean;
    } }).config;

    expect(config.enabledTools).toEqual([]);
    expect(config.enabledSkills).toEqual([]);
    expect(config.allowUnlistedDynamicTools).toBe(false);
  });

  it("keeps getToolRegistry pointed at the registry created for buildSync", () => {
    const builder = new AgentBuilder()
      .withWorkingDirectory(process.cwd())
      .withModelProvider(createModel());

    const beforeBuild = builder.getToolRegistry();
    builder.buildSync();
    const afterBuild = builder.getToolRegistry();

    expect(afterBuild).not.toBe(beforeBuild);
    expect(afterBuild.getDefinitions().some((tool) => tool.name === "read_file")).toBe(true);
  });
});
