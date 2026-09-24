import {
  SkillDiscoverTool,
  SkillLoadTool,
  SkillRegistry,
  ToolRegistry,
  registerBuiltinTools,
} from "@agent/core";
import { agentHost } from "../app/api/agent-host";

export function runtimeToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registerBuiltinTools(registry);
  const skills = new SkillRegistry();
  registry.register(new SkillDiscoverTool(skills, null));
  registry.register(new SkillLoadTool(skills, null));
  for (const tool of agentHost.getBuilder().getToolRegistry().getAll()) registry.register(tool);
  return registry;
}

export function runtimeToolIds(): string[] {
  return runtimeToolRegistry().getAll().map((tool) => tool.name).sort();
}
