import { describe, expect, it, vi } from "vitest";
import { SkillRegistry } from "../../skill/SkillRegistry.js";
import type { ISkillLoader, SkillDefinition } from "../../skill/entities.js";
import { SkillDiscoverTool, SkillLoadTool } from "./SkillTools.js";

const skill: SkillDefinition = {
  name: "docker-help",
  description: "Diagnose Docker container problems",
  triggers: ["docker", "container"],
  filePath: "/skills/docker-help/SKILL.md",
  source: "custom",
  prompt: "Follow the Docker diagnostic workflow.",
};

describe("SkillTools", () => {
  it("discovers metadata without loading the skill body", async () => {
    const loadFromFile = vi.fn();
    const loader = { loadFromFile } as unknown as ISkillLoader;
    const registry = new SkillRegistry(loader);
    registry.register({ ...skill, prompt: undefined } as unknown as SkillDefinition);
    const result = await new SkillDiscoverTool(registry, null).execute(
      { query: "docker issue" },
      { workingDirectory: "/tmp", sessionId: "s1" },
    );

    expect(result.content).toContain('"name":"docker-help"');
    expect(result.content).not.toContain("Docker diagnostic workflow");
    expect(result.metadata?.ephemeralSkillContext).toBe(true);
    expect(loadFromFile).not.toHaveBeenCalled();
  });

  it("loads one enabled skill body on demand as ephemeral context", async () => {
    const registry = new SkillRegistry();
    registry.register(skill);
    const result = await new SkillLoadTool(registry, ["docker-help"]).execute(
      { name: "docker-help" },
      { workingDirectory: "/tmp", sessionId: "s1" },
    );

    expect(result.content).toContain("Follow the Docker diagnostic workflow");
    expect(result.metadata?.ephemeralSkillContext).toBe(true);
  });
});
