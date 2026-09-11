import { AgentBuilder, MCPManager, ToolRegistry, LSPManager, LspDiagnosticsTool, LspHoverTool, LspDefinitionTool, LspReferencesTool, type SettingsData } from "@agent/core";
import { businessCatalog } from "./business-catalog";
import type { SharedSettings } from "./shared-settings";

export interface SharedRunOptions {
  model?: { provider: string; apiKey: string; modelId: string; baseUrl?: string };
  reasoningEffort?: SettingsData["reasoningEffort"];
  maxIterations?: number;
  maxTokens?: number;
  agentIds?: string[];
}

/** Each admitted run receives its own builder/config snapshot and MCP clients. */
export async function configureSharedRun(builder: AgentBuilder, settings: SharedSettings, options: SharedRunOptions) {
  const catalog = businessCatalog();
  const definitionId = options.agentIds?.[0] || settings.activeAgentIds[0];
  const definition = definitionId ? await catalog.agents.get(definitionId) : null;
  if (definitionId && !definition) throw new Error("所选智能体不存在，请重新选择");
  const profile = definition?.capabilities.profileId ? settings.profiles.find((p) => p.id === definition.capabilities.profileId) : null;
  const model = options.model || (profile ? { provider: profile.provider, apiKey: profile.apiKey, modelId: profile.modelId, baseUrl: profile.baseUrl } : { provider: settings.modelProvider, apiKey: settings.apiKey, modelId: settings.modelId, baseUrl: settings.baseUrl });
  if (model.apiKey) builder.withModel(model.provider, { ...model, baseUrl: model.baseUrl || undefined });
  builder.withMemoryStore(catalog.memory)
    .withMaxIterations(options.maxIterations ?? (definition?.maxIterations || settings.maxIterations))
    .withMaxTokens(options.maxTokens ?? settings.contextWindow * 1000)
    .withReasoningEffort(options.reasoningEffort ?? settings.reasoningEffort ?? "off");
  if (definition) {
    let prompt = definition.systemPrompt;
    for (const field of definition.contextPlaceholders) prompt = prompt.replaceAll(`{{${field.key}}}`, field.defaultValue);
    builder.withSystemPrompt(`# 当前角色：${definition.name}\n${definition.description}\n\n${prompt}`)
      .withEnabledTools(definition.capabilities.enabledTools)
      .withEnabledSkills(definition.capabilities.enabledSkills);
  }
  const tools = new ToolRegistry();
  const manager = new MCPManager(tools);
  const lsp = new LSPManager();
  const close = async () => { for (const config of manager.listServers()) await manager.disconnectServer(config.id).catch(() => undefined); await lsp.shutdownAll(); };
  try {
    for (const config of await catalog.mcp.list()) {
      const allowed = definition?.capabilities.enabledMCPServers;
      if (allowed?.length && !allowed.includes(config.id)) continue;
      await manager.connectServer(config);
      // MCPManager registers proxy tools into its registry.
      for (const tool of tools.getAll()) builder.withTool(tool);
    }
  } catch (error) { await close(); throw error; }
  const getConfigs = () => catalog.lsp.list();
  builder.withTool(new LspDiagnosticsTool(lsp, getConfigs)).withTool(new LspHoverTool(lsp, getConfigs))
    .withTool(new LspDefinitionTool(lsp, getConfigs)).withTool(new LspReferencesTool(lsp, getConfigs));
  return {
    close,
    async applySkills() {
      for (const skill of await catalog.skills.listAll()) {
        if ((skill as typeof skill & { enabled?: boolean }).enabled === false) builder.getSkillRegistry().unregister(skill.name);
        else builder.getSkillRegistry().register(skill);
      }
    },
  };
}
