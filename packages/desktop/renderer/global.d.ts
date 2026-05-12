export interface CronTask {
  id: string;
  cron: string;
  prompt: string;
  createdAt: number;
  recurring: boolean;
  enabled: boolean;
  label?: string;
  sessionId?: string;
  nextFireAt?: number;
  lastFiredAt?: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl: string;
}

export interface ContextPlaceholder {
  key: string;
  description: string;
  defaultValue: string;
}

export interface AgentCapabilities {
  profileId: string;
  enabledTools: string[];
  enabledSkills: string[];
  enabledMCPServers: string[];
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  contextPlaceholders: ContextPlaceholder[];
  capabilities: AgentCapabilities;
  maxIterations: number;
  isDefault: boolean;
  created: string;
  updated: string;
}

export interface TodoItem {
  id: string;
  title: string;
  agentName?: string;
  status: "pending" | "in-progress" | "completed";
}

export interface AgentApi {
  run(input: string, sessionId: string, agentIds?: string[], agentName?: string): Promise<unknown[]>;
  abort(): Promise<void>;
  subscribe(): Promise<void>;
  onEvent(callback: (event: unknown) => void): () => void;
  getSettings(): Promise<{
    modelProvider: string;
    modelId: string;
    apiKey: string;
    baseUrl: string;
    maxIterations: number;
    workingDirectory: string;
    profiles: ModelProfile[];
    activeProfileId: string;
  }>;
  setSetting(key: string, value: string): Promise<void>;
  saveSettings(settings: Record<string, unknown>): Promise<void>;
  setActiveProfile(profileId: string): Promise<void>;
  openFileDialog(): Promise<string | null>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<boolean>;
  listProjects(): Promise<unknown[]>;
  getProject(id: string): Promise<unknown>;
  createProject(name: string, description?: string): Promise<unknown>;
  updateProject(id: string, update: Record<string, unknown>): Promise<unknown>;
  deleteProject(id: string): Promise<void>;
  listSessions(projectId?: string): Promise<unknown[]>;
  getSession(id: string): Promise<unknown>;
  createSession(title: string, projectId?: string): Promise<unknown>;
  deleteSession(id: string): Promise<void>;
  listMemories(): Promise<unknown[]>;
  getMemory(name: string): Promise<unknown>;
  setMemory(entry: Record<string, unknown>): Promise<void>;
  deleteMemory(name: string): Promise<void>;
  searchMemories(query: string): Promise<unknown[]>;
  listSkills(): Promise<unknown[]>;
  saveSkill(skill: Record<string, unknown>): Promise<void>;
  deleteSkill(name: string): Promise<void>;
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  importSkill(): Promise<{ name: string; description: string } | null>;
  listUploads(): Promise<unknown[]>;
  getUpload(id: string): Promise<unknown>;
  saveUpload(entry: Record<string, unknown>): Promise<void>;
  deleteUpload(id: string): Promise<void>;
  setProjectWorkingDir(path: string): Promise<{ ok: boolean; path: string }>;
  // Agent Definitions
  listAgentDefs(): Promise<AgentDefinition[]>;
  getAgentDef(id: string): Promise<AgentDefinition | null>;
  createAgentDef(data: Partial<AgentDefinition>): Promise<AgentDefinition>;
  updateAgentDef(id: string, update: Partial<AgentDefinition>): Promise<AgentDefinition>;
  deleteAgentDef(id: string): Promise<void>;
  setActiveAgentDef(id: string): Promise<{ activeAgentId?: string }>;
  // Cron (scheduled tasks)
  cronCreate(cron: string, prompt: string, options?: Record<string, unknown>): Promise<CronTask>;
  cronPause(id: string): Promise<CronTask | null>;
  cronResume(id: string): Promise<CronTask | null>;
  cronDelete(id: string): Promise<boolean>;
  cronDeleteAll(): Promise<{ ok: boolean }>;
  cronList(): Promise<CronTask[]>;
}

declare global {
  interface Window {
    agentApi: AgentApi;
  }
}
