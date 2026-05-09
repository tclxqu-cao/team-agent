import { describe, it, expect } from "vitest";
import { SkillRegistry } from '../SkillRegistry.js';
import type { SkillDefinition } from '../entities.js';

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

  it("should unregister a skill", () => {
    const registry = new SkillRegistry();
    registry.register(makeSkill());
    registry.unregister("test-skill");

    expect(registry.get("test-skill")).toBeUndefined();
  });
});
