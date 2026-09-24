import type { AgentDefinition } from "../../domain/agent/entities.js";
import type { ISessionStore, Session } from "../../domain/session/entities.js";
import type { SkillDefinition } from "../../domain/skill/entities.js";
import type { ToolExecutionPolicy } from "../../domain/tool/execution-policy.js";

export type AgentRunSource = "desktop" | "webapp" | "sdk" | "portfolio" | "flow-studio";

export interface AgentRunCapabilitySelection {
  enabledTools?: string[];
  enabledSkills?: string[];
  activatedSkills?: string[];
  enabledMCPServers?: string[];
  memoryEnabled?: boolean;
  toolPolicyId?: string;
}

export interface StartAgentRunCommand {
  message: string;
  sessionId?: string;
  agentId?: string;
  skillName?: string;
  modelProfileId?: string;
  images?: string[];
  context?: Record<string, unknown>;
  capabilities?: AgentRunCapabilitySelection;
  session?: {
    projectId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  source: AgentRunSource;
}

export interface ValidatedAgentRun {
  message: string;
  sessionId: string;
  agent: AgentDefinition | null;
  skill: SkillDefinition | null;
  modelProfileId?: string;
  images?: string[];
  context: Record<string, unknown>;
  capabilities: AgentRunCapabilitySelection;
  toolExecutionPolicy?: ToolExecutionPolicy;
  source: AgentRunSource;
}

export interface StartedAgentRun {
  sessionId: string;
  runId: string;
  streamRef: string;
}

export interface AgentRunCatalog {
  getAgent(id: string): Promise<AgentDefinition | null>;
  getSkill(name: string): Promise<SkillDefinition | null>;
  hasModelProfile(id: string): Promise<boolean> | boolean;
  getToolExecutionPolicy?(id: string): Promise<ToolExecutionPolicy | null> | ToolExecutionPolicy | null;
}

export interface AgentRunRuntime {
  assertAvailable?(sessionId: string): Promise<void> | void;
  start(command: ValidatedAgentRun): Promise<StartedAgentRun> | StartedAgentRun;
}

export type AgentRunErrorCode =
  | "INVALID_RUN_REQUEST"
  | "AGENT_NOT_FOUND"
  | "SKILL_NOT_FOUND"
  | "MODEL_PROFILE_NOT_FOUND"
  | "SKILL_NOT_ALLOWED"
  | "TOOL_POLICY_NOT_FOUND"
  | "TOOL_POLICY_DISABLED";

export class AgentRunError extends Error {
  constructor(readonly code: AgentRunErrorCode, message: string) {
    super(message);
    this.name = "AgentRunError";
  }
}

const MAX_MESSAGE_LENGTH = 100_000;
const MAX_CONTEXT_LENGTH = 120_000;
const MAX_METADATA_LENGTH = 32_000;
const MAX_IDENTIFIER_LENGTH = 200;
const MAX_IMAGES = 20;

export class StartAgentRunUseCase {
  constructor(
    private readonly sessions: ISessionStore,
    private readonly catalog: AgentRunCatalog,
    private readonly runtime: AgentRunRuntime,
    private readonly createId: () => string = () => crypto.randomUUID(),
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async execute(raw: StartAgentRunCommand): Promise<StartedAgentRun> {
    const command = this.normalize(raw);
    const agent = command.agentId ? await this.catalog.getAgent(command.agentId) : null;
    if (command.agentId && !agent) {
      throw new AgentRunError("AGENT_NOT_FOUND", `Agent not found: ${command.agentId}`);
    }

    let skill: SkillDefinition | null = null;
    if (command.skillName) {
      if (!agent) throw new AgentRunError("INVALID_RUN_REQUEST", "skillName requires agentId");
      skill = await this.catalog.getSkill(command.skillName);
      if (!skill) throw new AgentRunError("SKILL_NOT_FOUND", `Skill not found: ${command.skillName}`);
      if (!agent.capabilities.enabledSkills.includes(command.skillName)) {
        throw new AgentRunError("SKILL_NOT_ALLOWED", `Skill is not enabled for Agent: ${command.skillName}`);
      }
    }

    if (command.modelProfileId && !await this.catalog.hasModelProfile(command.modelProfileId)) {
      throw new AgentRunError("MODEL_PROFILE_NOT_FOUND", `Model profile not found: ${command.modelProfileId}`);
    }

    let toolExecutionPolicy: ToolExecutionPolicy | undefined;
    const toolPolicyId = command.capabilities?.toolPolicyId;
    if (toolPolicyId) {
      toolExecutionPolicy = await this.catalog.getToolExecutionPolicy?.(toolPolicyId) ?? undefined;
      if (!toolExecutionPolicy) {
        throw new AgentRunError("TOOL_POLICY_NOT_FOUND", `Tool policy not found: ${toolPolicyId}`);
      }
      if (!toolExecutionPolicy.enabled) {
        throw new AgentRunError("TOOL_POLICY_DISABLED", `Tool policy is disabled: ${toolPolicyId}`);
      }
    }

    const sessionId = command.sessionId ?? this.createId();
    await this.runtime.assertAvailable?.(sessionId);
    let session = await this.sessions.get(sessionId);
    const runMetadata = {
      ...(command.session?.metadata ?? {}),
      source: command.source,
      ...(command.agentId ? { agentId: command.agentId } : {}),
      ...(command.skillName ? { skillName: command.skillName } : {}),
      ...(command.modelProfileId ? { modelProfileId: command.modelProfileId } : {}),
      ...(toolPolicyId ? { toolPolicyId } : {}),
    };
    if (!session) {
      const timestamp = this.now();
      session = await this.sessions.create({
        id: sessionId,
        projectId: command.session?.projectId ?? "",
        title: command.session?.title ?? (command.message.slice(0, 60) || "New Session"),
        status: "idle",
        messages: [],
        events: [],
        created: timestamp,
        updated: timestamp,
        metadata: runMetadata,
      });
    } else if (Object.keys(runMetadata).length > 0) {
      session = await this.sessions.update(sessionId, {
        metadata: { ...session.metadata, ...runMetadata },
        updated: this.now(),
      });
    }

    return this.runtime.start({
      message: command.message,
      sessionId: session.id,
      agent,
      skill,
      ...(command.modelProfileId ? { modelProfileId: command.modelProfileId } : {}),
      ...(command.images?.length ? { images: command.images } : {}),
      context: command.context ?? {},
      capabilities: command.capabilities ?? {},
      ...(toolExecutionPolicy ? { toolExecutionPolicy: structuredClone(toolExecutionPolicy) } : {}),
      source: command.source,
    });
  }

  private normalize(raw: StartAgentRunCommand): StartAgentRunCommand {
    if (!raw || typeof raw !== "object") throw invalid("Run command is required");
    const message = requiredString(raw.message, "message", MAX_MESSAGE_LENGTH);
    const sessionId = optionalString(raw.sessionId, "sessionId");
    const agentId = optionalString(raw.agentId, "agentId");
    const skillName = optionalString(raw.skillName, "skillName");
    const modelProfileId = optionalString(raw.modelProfileId, "modelProfileId");
    if (!RUN_SOURCES.has(raw.source)) throw invalid("source is invalid");
    if (raw.images !== undefined && (!Array.isArray(raw.images) || raw.images.length > MAX_IMAGES || raw.images.some((image) => typeof image !== "string" || !image))) {
      throw invalid(`images must contain at most ${MAX_IMAGES} non-empty strings`);
    }
    const context = jsonRecord(raw.context, "context", MAX_CONTEXT_LENGTH);
    const capabilities = capabilitySelection(raw.capabilities);
    const metadata = jsonRecord(raw.session?.metadata, "session.metadata", MAX_METADATA_LENGTH);
    const projectId = optionalString(raw.session?.projectId, "session.projectId");
    const title = optionalString(raw.session?.title, "session.title");
    return {
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(skillName ? { skillName } : {}),
      ...(modelProfileId ? { modelProfileId } : {}),
      ...(raw.images?.length ? { images: [...raw.images] } : {}),
      context,
      capabilities,
      session: {
        ...(projectId ? { projectId } : {}),
        ...(title ? { title } : {}),
        metadata,
      },
      source: raw.source,
    };
  }
}

function capabilitySelection(value: AgentRunCapabilitySelection | undefined): AgentRunCapabilitySelection {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("capabilities must be an object");
  const selected: AgentRunCapabilitySelection = {};
  for (const field of ["enabledTools", "enabledSkills", "activatedSkills", "enabledMCPServers"] as const) {
    const raw = value[field];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.length > 200 || raw.some((item) => typeof item !== "string" || !item.trim() || item.length > MAX_IDENTIFIER_LENGTH)) {
      throw invalid(`capabilities.${field} must contain at most 200 non-empty identifiers`);
    }
    selected[field] = [...new Set(raw.map((item) => item.trim()))];
  }
  if (value.memoryEnabled !== undefined) {
    if (typeof value.memoryEnabled !== "boolean") throw invalid("capabilities.memoryEnabled must be boolean");
    selected.memoryEnabled = value.memoryEnabled;
  }
  const toolPolicyId = optionalString(value.toolPolicyId, "capabilities.toolPolicyId");
  if (toolPolicyId) selected.toolPolicyId = toolPolicyId;
  if (selected.activatedSkills && selected.enabledSkills) {
    const allowed = new Set(selected.enabledSkills);
    if (selected.activatedSkills.some((skill) => !allowed.has(skill))) {
      throw invalid("capabilities.activatedSkills must be a subset of enabledSkills");
    }
  }
  return selected;
}

const RUN_SOURCES = new Set<AgentRunSource>(["desktop", "webapp", "sdk", "portfolio", "flow-studio"]);

function requiredString(value: unknown, field: string, max = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw invalid(`${field} must be a non-empty string no longer than ${max} characters`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function jsonRecord(value: unknown, field: string, max: number): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${field} must be an object`);
  let encoded: string;
  try { encoded = JSON.stringify(value); }
  catch { throw invalid(`${field} must be JSON serializable`); }
  if (encoded.length > max) throw invalid(`${field} is too large`);
  return value as Record<string, unknown>;
}

function invalid(message: string): AgentRunError {
  return new AgentRunError("INVALID_RUN_REQUEST", message);
}
