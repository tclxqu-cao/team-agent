import { describe, it, expect } from "vitest";
import { SkillRegistry } from '../SkillRegistry.js';
import type { SkillDefinition } from '../entities.js';
import type { IModelProvider, StreamEvent, StreamOptions } from '../../model/entities.js';

describe("SkillRegistry", () => {
  const makeSkill = (overrides?: Partial<SkillDefinition>): SkillDefinition => ({
    name: "test-skill",
    description: "A test skill",
    triggers: ["test", "testing"],
    prompt: "You are a test expert.",
    filePath: "/skills/test/SKILL.md",
    source: "custom",
    ...overrides,
  });

  const makeSemanticModel = (skillName: string, onCall: () => void): IModelProvider => ({
    providerId: "mock",
    modelId: "mock-model",
    streamChat: async function* (): AsyncIterable<StreamEvent> {
      onCall();
      yield { type: "text_chunk", text: skillName };
      yield { type: "text_done" };
    },
    countTokens: async () => 10,
    supportsModel: () => true,
  });


  it("should register and retrieve a skill", () => {
    const registry = new SkillRegistry();
    const skill = makeSkill();
    registry.register(skill);

    expect(registry.get("test-skill")).toBe(skill);
  });

  it("should find matching skills by trigger", () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill({ name: "docker-skill", triggers: ["docker", "container"] }));
    registry.register(makeSkill({ name: "python-skill", triggers: ["python", "pip"] }));

    const matched = registry.findMatching("I need help with docker containers");
    expect(matched).toHaveLength(1);
    expect(matched[0].name).toBe("docker-skill");
  });

  it("should match case-insensitively", () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill({ triggers: ["Docker", "Container"] }));

    const matched = registry.findMatching("docker");
    expect(matched).toHaveLength(1);
  });

  it("should generate skill prompts for matched skills", async () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill({
      name: "git-skill",
      triggers: ["git"],
      prompt: "Git expert prompt here.",
    }));

    const prompts = await registry.getSkillPrompts("how do I git rebase");
    expect(prompts).toContain("git-skill");
    expect(prompts).toContain("Git expert prompt here");
  });

  it("should return empty string when no skills match", async () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill({ triggers: ["docker"] }));

    const prompts = await registry.getSkillPrompts("python help");
    expect(prompts).toBe("");
  });

  it("uses semantic matching by default and can disable the fallback", async () => {
    let streamChatCalls = 0;
    const registry = new SkillRegistry();
    registry.register(makeSkill());
    registry.setModelProvider(makeSemanticModel("test-skill", () => streamChatCalls++));

    expect(await registry.getSkillPrompts("an unmatched request")).toContain("test-skill");
    expect(streamChatCalls).toBe(1);

    registry.setSemanticMatchingEnabled(false);

    expect(await registry.getSkillPrompts("another unmatched request")).toBe("");
    expect(streamChatCalls).toBe(1);
  });

  it("does not call semantic matching when the allowlist excludes every skill", async () => {
    let streamChatCalls = 0;
    const registry = new SkillRegistry();
    registry.register(makeSkill());
    registry.setModelProvider(makeSemanticModel("test-skill", () => streamChatCalls++));

    expect(await registry.getSkillPrompts("an unmatched request", ["other-skill"])).toBe("");
    expect(streamChatCalls).toBe(0);
  });

  it("treats an explicit empty allowlist as disabling every skill", async () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill());

    expect(registry.discover("test", [])).toEqual([]);
    await expect(registry.load("test-skill", [])).resolves.toBeNull();
    await expect(registry.getSkillPrompts("test", [])).resolves.toBe("");
  });

  it("passes the project directory and full tool definitions to semantic skill matching", async () => {
    let received: StreamOptions | undefined;
    const registry = new SkillRegistry();
    registry.register(makeSkill());
    registry.setModelProvider({
      ...makeSemanticModel("test-skill", () => {}),
      streamChat: async function* (_messages, options): AsyncIterable<StreamEvent> {
        received = options;
        yield { type: "text_chunk", text: "test-skill" };
        yield { type: "text_done" };
      },
    });
    const tools = [{ name: "skill_discover", description: "发现并加载技能", parameters: { type: "object" } }];

    await registry.getSkillPrompts("an unmatched request", null, {
      workingDirectory: "/Users/demo/project",
      tools,
    });

    expect(received?.workingDirectory).toBe("/Users/demo/project");
    expect(received?.tools).toEqual(tools);
  });

  it("should unregister a skill", () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill());
    registry.unregister("test-skill");

    expect(registry.get("test-skill")).toBeUndefined();
  });
});
