import { timingSafeEqual } from "node:crypto";
import type { AgentEvent } from "@agent/core";
import { agentHost } from "../app/api/agent-host";
import { businessCatalog } from "./business-catalog";
import { sharedSettings } from "./shared-settings";
import { toolExecutionPolicies } from "./tool-execution-policies";
import { runtimeToolRegistry } from "./runtime-tool-catalog";

export const FLOW_PROTOCOL_VERSION = "1";
const MAX_IDS = 200;
const MAX_ID_LENGTH = 200;
const MAX_INPUT_LENGTH = 100_000;
const MAX_CONTEXT_LENGTH = 120_000;
const RUN_TTL_MS = 60 * 60 * 1000;
const MAX_RUNS = 500;

export interface FlowRunSelection {
  modelId?: string;
  skillIds?: string[];
  activatedSkillIds?: string[];
  toolIds?: string[];
  mcpServerIds?: string[];
  memoryEnabled?: boolean;
  toolPolicyId?: string;
}

export interface FlowRunRequest {
  input: string;
  instructions?: string;
  agentId?: string;
  sessionId?: string;
  context: Record<string, unknown>;
  selection: FlowRunSelection;
}

export interface NormalizedFlowEvent {
  id: number;
  event: "assistant.delta" | "tool.started" | "tool.completed" | "run.completed" | "run.failed";
  data: Record<string, unknown>;
}

export class FlowProtocolError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "FlowProtocolError";
  }
}

interface FlowRunRecord {
  runId: string;
  sessionId: string;
  createdAt: number;
}

const flowRuns = new Map<string, FlowRunRecord>();

export function assertFlowAuthorized(request: Request): void {
  const expected = (process.env.AGENT_RUN_TOKEN
    || process.env.PORTFOLIO_SKILL_TOKEN)?.trim();
  if (!expected) return;
  const header = request.headers.get("authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new FlowProtocolError("UNAUTHORIZED", "Flow protocol authentication failed", 401);
  }
}

export function flowErrorResponse(error: unknown): Response {
  if (error instanceof FlowProtocolError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Flow protocol request failed";
  const sourceCode = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (sourceCode === "SESSION_OCCUPIED" || sourceCode === "SESSION_ALREADY_RUNNING") {
    return Response.json({ error: message, code: "SESSION_OCCUPIED" }, { status: 409 });
  }
  const capabilityStatuses: Record<string, number> = {
    AGENT_NOT_FOUND: 404,
    SKILL_NOT_FOUND: 404,
    MODEL_PROFILE_NOT_FOUND: 404,
    SKILL_NOT_ALLOWED: 422,
    TOOL_POLICY_NOT_FOUND: 404,
    TOOL_POLICY_DISABLED: 422,
  };
  if (sourceCode in capabilityStatuses) {
    return Response.json({ error: message, code: "INVALID_CAPABILITY" }, {
      status: capabilityStatuses[sourceCode],
    });
  }
  if (sourceCode === "INVALID_RUN_REQUEST") {
    return Response.json({ error: message, code: "INVALID_REQUEST" }, { status: 400 });
  }
  return Response.json({ error: message, code: "RUN_FAILED" }, { status: 500 });
}

export async function flowCatalog() {
  const settings = sharedSettings().publicView();
  const catalog = businessCatalog();
  const skills = await catalog.call("listSkills", []) as Array<{
    name: string;
    description?: string;
    enabled?: boolean;
  }>;
  const tools = runtimeToolRegistry().getAll();
  const mcpServers = await catalog.mcp.listAll();
  return {
    protocolVersion: FLOW_PROTOCOL_VERSION,
    provider: { id: "customer-agent", name: "Customer Agent" },
    features: { streaming: true, memory: true, cancellation: true },
    models: settings.profiles.map((profile) => ({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      modelId: profile.modelId,
    })),
    skills: skills
      .filter((skill) => skill.enabled !== false)
      .map((skill) => ({ id: skill.name, name: skill.name, description: skill.description ?? "" })),
    tools: tools.map((tool) => ({
      id: tool.name,
      name: tool.name,
      description: tool.description,
      inputSchema: tool.parameters,
    })),
    mcpServers: mcpServers.map((server) => ({
      id: server.id,
      name: server.name || server.id,
      status: "available",
    })),
    toolPolicies: await toolExecutionPolicies().summaries(),
  };
}

export function parseFlowRunRequest(value: unknown): FlowRunRequest {
  const body = record(value, "request");
  const input = requiredString(body.input, "input", MAX_INPUT_LENGTH);
  const instructions = optionalText(body.instructions, "instructions", 32_000);
  const agentId = optionalString(body.agentId, "agentId");
  const sessionId = optionalString(body.sessionId, "sessionId");
  const context = body.context === undefined ? {} : record(body.context, "context");
  if (JSON.stringify(context).length > MAX_CONTEXT_LENGTH) {
    throw new FlowProtocolError("INVALID_REQUEST", "context is too large");
  }
  const rawSelection = body.selection === undefined ? {} : record(body.selection, "selection");
  const selection: FlowRunSelection = {};
  selection.modelId = optionalString(rawSelection.modelId, "selection.modelId");
  selection.toolPolicyId = optionalString(rawSelection.toolPolicyId, "selection.toolPolicyId");
  for (const [wireName, targetName] of [
    ["skillIds", "skillIds"],
    ["activatedSkillIds", "activatedSkillIds"],
    ["toolIds", "toolIds"],
    ["mcpServerIds", "mcpServerIds"],
  ] as const) {
    const parsed = optionalIds(rawSelection[wireName], `selection.${wireName}`);
    if (parsed !== undefined) selection[targetName] = parsed;
  }
  if (rawSelection.memoryEnabled !== undefined) {
    if (typeof rawSelection.memoryEnabled !== "boolean") {
      throw new FlowProtocolError("INVALID_REQUEST", "selection.memoryEnabled must be boolean");
    }
    selection.memoryEnabled = rawSelection.memoryEnabled;
  }
  if (selection.skillIds && selection.activatedSkillIds) {
    const enabled = new Set(selection.skillIds);
    if (selection.activatedSkillIds.some((skill) => !enabled.has(skill))) {
      throw new FlowProtocolError("INVALID_REQUEST", "activatedSkillIds must be a subset of skillIds");
    }
  }
  return {
    input,
    ...(instructions ? { instructions } : {}),
    ...(agentId ? { agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    context,
    selection,
  };
}

export async function validateFlowRunRequest(request: FlowRunRequest): Promise<void> {
  const catalog = await flowCatalog();
  if (request.agentId && !await businessCatalog().agents.get(request.agentId)) {
    throw new FlowProtocolError("INVALID_CAPABILITY", `Unknown Agent: ${request.agentId}`, 404);
  }
  assertKnown(request.selection.modelId ? [request.selection.modelId] : undefined, catalog.models, "model");
  assertKnown(request.selection.skillIds, catalog.skills, "Skill");
  assertKnown(request.selection.activatedSkillIds, catalog.skills, "activated Skill");
  assertKnown(request.selection.toolIds, catalog.tools, "Tool");
  assertKnown(request.selection.mcpServerIds, catalog.mcpServers, "MCP server");
  assertKnown(request.selection.toolPolicyId ? [request.selection.toolPolicyId] : undefined, catalog.toolPolicies, "tool policy");
}

export function registerFlowRun(runId: string, sessionId: string): void {
  pruneFlowRuns();
  flowRuns.set(runId, { runId, sessionId, createdAt: Date.now() });
  while (flowRuns.size > MAX_RUNS) flowRuns.delete(flowRuns.keys().next().value as string);
}

export function flowRun(runId: string): FlowRunRecord {
  pruneFlowRuns();
  const found = flowRuns.get(runId);
  if (!found) throw new FlowProtocolError("RUN_NOT_FOUND", "Flow protocol run not found", 404);
  return found;
}

export function mapFlowEvent(
  runId: string,
  sessionId: string,
  id: number,
  event: AgentEvent,
): NormalizedFlowEvent | null {
  const common = { runId, sessionId, timestamp: new Date().toISOString() };
  if (event.type === "text_chunk") {
    return { id, event: "assistant.delta", data: { ...common, text: event.text } };
  }
  if (event.type === "tool_call") {
    return { id, event: "tool.started", data: {
      ...common,
      callId: event.toolCall.id,
      name: event.toolCall.name,
      arguments: event.toolCall.arguments,
    } };
  }
  if (event.type === "tool_result") {
    return { id, event: "tool.completed", data: {
      ...common,
      callId: event.result.toolCallId,
      content: event.result.content,
      isError: event.result.isError === true,
    } };
  }
  if (event.type === "done") {
    return { id, event: "run.completed", data: {
      ...common,
      text: event.finalText,
      durationMs: event.durationMs,
      usage: event.usage,
    } };
  }
  if (event.type === "error") {
    return { id, event: "run.failed", data: {
      ...common,
      code: event.code || "RUN_FAILED",
      message: event.message,
    } };
  }
  if (event.type === "turn_aborted") {
    return { id, event: "run.failed", data: {
      ...common,
      code: "RUN_CANCELLED",
      message: "Run cancelled",
    } };
  }
  return null;
}

function pruneFlowRuns(): void {
  const cutoff = Date.now() - RUN_TTL_MS;
  for (const [id, run] of flowRuns) if (run.createdAt < cutoff) flowRuns.delete(id);
}

function assertKnown(
  selected: string[] | undefined,
  catalog: Array<{ id: string }>,
  label: string,
): void {
  if (selected === undefined) return;
  const known = new Set(catalog.map((item) => item.id));
  const unknown = selected.find((id) => !known.has(id));
  if (unknown) throw new FlowProtocolError("INVALID_CAPABILITY", `Unknown ${label}: ${unknown}`, 422);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FlowProtocolError("INVALID_REQUEST", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, max = MAX_ID_LENGTH): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new FlowProtocolError("INVALID_REQUEST", `${field} must be a non-empty string no longer than ${max} characters`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field);
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, field, max);
}

function optionalIds(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_IDS) {
    throw new FlowProtocolError("INVALID_REQUEST", `${field} must contain at most ${MAX_IDS} identifiers`);
  }
  const values = value.map((item) => requiredString(item, field));
  if (new Set(values).size !== values.length) {
    throw new FlowProtocolError("INVALID_REQUEST", `${field} contains duplicate identifiers`);
  }
  return values;
}
