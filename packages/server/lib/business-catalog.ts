import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SQLiteAgentStore, SQLiteLSPServerStore, SQLiteMCPServerStore, SQLiteSkillStore,
  SQLiteUploadStore, SQLiteMemoryStore, SkillLoader, MCPManager,
  type AgentDefinition, type LSPServerConfig, type MCPServerConfig, type SkillDefinition, type UploadEntry, type MemoryEntry,
} from "@agent/core";
import { COMPUTER_USE_SKILL } from "@agent/computer-use";
import { getServerBaseDir } from "./server-data-dir";
import { sharedSettings } from "./shared-settings";
import { portfolioSkillsDirectory, PORTFOLIO_SKILL_PREFIX } from "./portfolio-skill-catalog";

/** Explicit method table: no arbitrary method/property invocation over HTTP. */
export class BusinessCatalog {
  readonly agents; readonly lsp; readonly mcp; readonly skills; readonly uploads; readonly memory;
  constructor(baseDir: string) {
    this.agents = new SQLiteAgentStore(baseDir);
    this.lsp = new SQLiteLSPServerStore(baseDir);
    this.mcp = new SQLiteMCPServerStore(baseDir);
    this.skills = new SQLiteSkillStore(baseDir);
    this.uploads = new SQLiteUploadStore(baseDir);
    this.memory = new SQLiteMemoryStore(baseDir);
  }
  async call(method: string, args: unknown[]): Promise<unknown> {
    const id = () => requiredString(args[0]);
    const enabled = () => { if (typeof args[1] !== "boolean") throw new Error("enabled must be boolean"); return args[1]; };
    const item = () => record(args[0]);
    switch (method) {
      case "importLegacy": {
        const legacy = item();
        const result = { profiles: 0, agents: 0, lsp: 0, preserved: 0 };
        const settings = sharedSettings().publicView();
        const profiles = [...settings.profiles];
        if (Array.isArray(legacy.profiles)) for (const profile of legacy.profiles) {
          if (!profile || typeof profile !== "object" || typeof profile.id !== "string") continue;
          if (profile.apiKey === "managed") continue;
          if (profiles.some((p) => p.id === profile.id)) { result.preserved++; continue; }
          profiles.push(profile); result.profiles++;
        }
        if (result.profiles) sharedSettings().save({ profiles, activeProfileId: settings.activeProfileId || profiles[0]?.id || "", revision: settings.revision });
        if (Array.isArray(legacy.agents)) for (const raw of legacy.agents) {
          const value = record(raw); const id = requiredString(value.id);
          if (await this.agents.get(id)) { result.preserved++; continue; }
          await this.agents.create(value as unknown as AgentDefinition); result.agents++;
        }
        if (Array.isArray(legacy.lsp)) for (const raw of legacy.lsp) {
          const value = record(raw); const id = requiredString(value.id);
          if (await this.lsp.get(id)) { result.preserved++; continue; }
          await this.lsp.save(value as unknown as LSPServerConfig); result.lsp++;
        }
        return result;
      }
      case "mcpList": return this.mcp.listAll();
      case "mcpSave": { const value = item(); requiredString(value.id); requiredString(value.name); await this.mcp.save(value as unknown as MCPServerConfig); if (value.enabled === false) await this.mcp.setEnabled(String(value.id), false); return null; }
      case "mcpDelete": await this.mcp.delete(id()); return null;
      case "mcpSetEnabled": await this.mcp.setEnabled(id(), enabled()); return null;
      case "mcpProbe": {
        const manager = new MCPManager(); const config = item() as unknown as MCPServerConfig;
        requiredString(config.id);
        try { const client = await manager.connectServer(config); return (await client.listTools()).map(({ name, description }) => ({ name, description })); }
        finally { await manager.disconnectServer(config.id); }
      }
      case "listSkills": {
        const stored = await this.skills.listAll();
        const loader = new SkillLoader();
        const discovered = await loader.loadAll(sharedSettings().read().workingDirectory);
        const all = new Map(discovered.map((s) => [s.name, { ...s, enabled: true }]));
        for (const s of stored) all.set(s.name, { ...all.get(s.name), ...s, enabled: (s as SkillDefinition & { enabled?: boolean }).enabled !== false });
        const portfolio = await loader.loadFromDirectory(portfolioSkillsDirectory(), "project");
        for (const skill of portfolio.filter((item) => item.name.startsWith(PORTFOLIO_SKILL_PREFIX))) {
          const current = all.get(skill.name);
          all.set(skill.name, { ...current, ...skill, enabled: current?.enabled !== false });
        }
        all.set(COMPUTER_USE_SKILL.name, { ...COMPUTER_USE_SKILL, enabled: true });
        return [...all.values()];
      }
      case "saveSkill": { const value = item(); requiredString(value.name); await this.skills.save({ description: "", triggers: [], prompt: "", filePath: "", source: "custom", ...value } as unknown as SkillDefinition); return null; }
      case "deleteSkill": await this.skills.delete(id()); return null;
      case "setSkillEnabled": {
        const name = id(); const on = enabled();
        if (!await this.skills.get(name)) {
          const loader = new SkillLoader();
          const discovered = [
            ...await loader.loadAll(sharedSettings().read().workingDirectory),
            ...await loader.loadFromDirectory(portfolioSkillsDirectory(), "project"),
          ];
          const meta = discovered.find((s) => s.name === name);
          if (!meta) throw new Error("Skill not found");
          await this.skills.save(await loader.loadFromFile(meta.filePath));
        }
        await this.skills.setEnabled(name, on); return null;
      }
      case "importSkill": {
        const meta = await new SkillLoader().installSkill(id(), join(homedir(), ".agent", "skills"));
        await this.skills.save(await new SkillLoader().loadFromFile(meta.filePath));
        return meta;
      }
      case "listAgentDefs": { const active = sharedSettings().read().activeAgentIds; return (await this.agents.list()).map((a) => ({ ...a, isActive: active.includes(a.id) })); }
      case "getAgentDef": return this.agents.get(id());
      case "createAgentDef": {
        const value = item(); const now = new Date().toISOString();
        return this.agents.create({ name: "新智能体", description: "", systemPrompt: "", contextPlaceholders: [], capabilities: { profileId: "", enabledTools: [], enabledSkills: [], enabledMCPServers: [] }, maxIterations: 10, isDefault: false, ...value, id: randomUUID(), created: now, updated: now } as AgentDefinition);
      }
      case "updateAgentDef": return this.agents.update(id(), record(args[1]));
      case "deleteAgentDef": await this.agents.delete(id()); return sharedSettings().save({ activeAgentIds: sharedSettings().read().activeAgentIds.filter((a) => a !== id()) });
      case "setActiveAgentDef": {
        if (!await this.agents.get(id())) throw new Error("Agent not found");
        const active = sharedSettings().read().activeAgentIds;
        return sharedSettings().save({ activeAgentIds: active.includes(id()) ? active.filter((a) => a !== id()) : [...active, id()] });
      }
      case "lspList": return this.lsp.listAll();
      case "lspSave": { const value = item(); requiredString(value.name); requiredString(value.command); await this.lsp.save({ id: randomUUID(), enabled: true, ...value } as unknown as LSPServerConfig); return null; }
      case "lspDelete": await this.lsp.delete(id()); return null;
      case "lspSetEnabled": await this.lsp.setEnabled(id(), enabled()); return null;
      case "listUploads": return this.uploads.list();
      case "getUpload": return this.uploads.get(id());
      case "saveUpload": { const value = item(); requiredString(value.id); await this.uploads.save(value as unknown as UploadEntry); return null; }
      case "deleteUpload": await this.uploads.delete(id()); return null;
      case "listMemories": return this.memory.list();
      case "getMemory": return this.memory.get(id());
      case "searchMemories": return this.memory.search(id());
      case "setMemory": { const value = item(); requiredString(value.name); requiredString(value.content); await this.memory.set(value as unknown as MemoryEntry); return null; }
      case "deleteMemory": await this.memory.delete(id()); return null;
      default: throw new Error(`Unsupported business operation: ${method}`);
    }
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Object required");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768) throw new Error("Non-empty string required");
  return value;
}
let singleton: BusinessCatalog | undefined;
export function businessCatalog(): BusinessCatalog { return singleton ??= new BusinessCatalog(getServerBaseDir()); }
