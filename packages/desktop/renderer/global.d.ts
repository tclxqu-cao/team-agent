export interface LSPServerConfig {
  id: string;
  name: string;
  language: string;
  fileTypes: string[];
  command: string;
  args: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

export interface MCPServer {
  id: string;
  name: string;
  transport: "stdio" | "sse" | "streamableHttp";
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // sse/remote
  url?: string;
  // custom HTTP headers (streamableHttp / authenticated sse)
  headers?: Record<string, string>;
  enabled?: boolean;
}

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
  // Window control (hide → background voice-wake mode, show → restore)
  hideWindow(): Promise<void>;
  showWindow(): Promise<void>;
  isWindowVisible(): Promise<boolean>;
  // Native wake-word listener (macOS Speech framework)
  wakeStart(wakeWord: string): Promise<{ ok: boolean; reason?: string }>;
  wakeStop(): Promise<{ ok: boolean }>;
  onWake(callback: (heard: string) => void): () => void;
  // Voice command captured right after the wake word fired
  onWakeCommand(callback: (payload: { text: string }) => void): () => void;
  // Two-way voice conversation mode (follow-ups without wake word)
  wakeConversation(on: boolean): Promise<{ ok: boolean; conversation: boolean }>;
  // Native one-shot dictation for the chat input
  dictationStart(): Promise<{ ok: boolean; reason?: string }>;
  dictationStop(): Promise<{ ok: boolean }>;
  onDictation(callback: (payload: { text: string; isFinal: boolean }) => void): () => void;
  onDictationError(callback: (message: string) => void): () => void;
  // Native TTS (macOS `say`)
  ttsSpeak(text: string): Promise<{ ok: boolean }>;
  ttsStop(): Promise<{ ok: boolean }>;
  run(input: string, sessionId: string, agentIds?: string[], agentName?: string, images?: string[]): Promise<unknown[]>;
  steer(input: string, sessionId: string, agentName?: string): Promise<boolean>;
  abort(): Promise<void>;
  answerQuestion(questionId: string, answer: string, selectedIndices?: number[]): Promise<boolean>;
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
  checkProjectPath(path: string): Promise<boolean>;
  listSessions(projectId?: string): Promise<unknown[]>;
  listChildSessions(parentId: string): Promise<unknown[]>;
  getSession(id: string): Promise<unknown>;
  createSession(title: string, projectId?: string): Promise<unknown>;
  deleteSession(id: string): Promise<void>;
  listMemories(): Promise<unknown[]>;
  getMemory(name: string): Promise<unknown>;
  setMemory(entry: Record<string, unknown>): Promise<void>;
  deleteMemory(name: string): Promise<void>;
  searchMemories(query: string): Promise<unknown[]>;
  mcpList(): Promise<MCPServer[]>;
  mcpSave(server: Omit<MCPServer, 'transport'> & { transport?: string }): Promise<void>;
  mcpDelete(id: string): Promise<void>;
  mcpSetEnabled(id: string, enabled: boolean): Promise<void>;
  mcpProbe(server: MCPServer): Promise<Array<{ name: string; description: string }>>;

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
  // LSP Servers
  lspList(): Promise<LSPServerConfig[]>;
  lspSave(config: Omit<LSPServerConfig, 'id'> & { id?: string }): Promise<void>;
  lspDelete(id: string): Promise<void>;
  lspSetEnabled(id: string, enabled: boolean): Promise<void>;
}

declare global {
  interface Window {
    agentApi: AgentApi;
  }
}
