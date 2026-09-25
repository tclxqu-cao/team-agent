import {
  DispatchAgentTool,
  SkillDiscoverTool,
  SkillLoadTool,
  SkillRegistry,
  ToolRegistry,
  WaitAgentTool,
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
  // 会话级派发工具：真实执行在每次 run 的 registerCustomerTools 里注入
  // SubAgentDispatcher；此处 no-op 回调仅为让 flow catalog 与工具策略能枚举它们。
  registry.register(
    new DispatchAgentTool(async () => ({
      status: "failed",
      agentName: "",
      subSessionId: "",
      error: "catalog listing only; dispatch runs inside a Customer Agent session",
    })),
  );
  registry.register(
    new WaitAgentTool(async () => ({
      status: "failed",
      agentName: "",
      subSessionId: "",
      error: "catalog listing only; dispatch runs inside a Customer Agent session",
    })),
  );
  return registry;
}

export function runtimeToolIds(): string[] {
  return runtimeToolRegistry().getAll().map((tool) => tool.name).sort();
}
