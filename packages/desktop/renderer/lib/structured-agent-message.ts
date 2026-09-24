export const MAX_STRUCTURED_MESSAGE_CHARS = 200_000;

const MAX_BLOCKS = 24;
const MAX_SUGGESTIONS = 12;
const MAX_SUGGESTION_CHARS = 80;
const MAX_SOURCES = 30;
const MAX_SOURCE_CHARS = 500;
const MAX_TITLE_CHARS = 160;
const MAX_SUMMARY_CHARS = 1_000;
const MAX_METADATA_CHARS = 200;

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type AgentMessageBlock =
  | { kind: "text"; text: string; tone?: string }
  | { kind: "unknown"; blockType: string; value: JsonValue };

export interface AgentMessageEnvelope {
  schemaVersion: number;
  title: string;
  skill?: string;
  summary?: string;
  generatedAt?: string;
  blocks: AgentMessageBlock[];
  suggestions: string[];
  sources: string[];
  original: JsonObject;
}

export type StructuredAgentMessage =
  | { kind: "envelope"; raw: string; value: AgentMessageEnvelope }
  | { kind: "json"; raw: string; value: JsonObject | JsonValue[] };

const SUGGESTION_LABELS: Record<string, string> = {
  "/help": "使用帮助",
  "/whoami": "关于我",
  "/works": "项目与作品",
  "/jobs": "求职信息",
  "/timeline": "经历时间线",
  "/contact": "联系方式",
};

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: JsonValue | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxChars) : undefined;
}

function normalizeStringList(value: JsonValue | undefined, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxItems)
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, maxChars))
    .filter(Boolean);
}

function normalizeBlock(value: JsonValue): AgentMessageBlock {
  if (isJsonObject(value)) {
    const blockType = optionalString(value.type, MAX_METADATA_CHARS) ?? "unknown";
    if (blockType === "text") {
      const text = optionalString(value.text, MAX_STRUCTURED_MESSAGE_CHARS);
      if (text) {
        const tone = optionalString(value.tone, MAX_METADATA_CHARS);
        return { kind: "text", text, ...(tone ? { tone } : {}) };
      }
    }
    return { kind: "unknown", blockType, value };
  }
  return { kind: "unknown", blockType: "unknown", value };
}

function normalizeEnvelope(value: JsonObject): AgentMessageEnvelope | null {
  if (typeof value.schemaVersion !== "number" || !Number.isFinite(value.schemaVersion)) return null;
  const title = optionalString(value.title, MAX_TITLE_CHARS);
  if (!title || !Array.isArray(value.blocks)) return null;

  const skill = optionalString(value.skill, MAX_METADATA_CHARS);
  const summary = optionalString(value.summary, MAX_SUMMARY_CHARS);
  const generatedAt = optionalString(value.generatedAt, MAX_METADATA_CHARS);
  return {
    schemaVersion: value.schemaVersion,
    title,
    ...(skill ? { skill } : {}),
    ...(summary ? { summary } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    blocks: value.blocks.slice(0, MAX_BLOCKS).map(normalizeBlock),
    suggestions: normalizeStringList(value.suggestions, MAX_SUGGESTIONS, MAX_SUGGESTION_CHARS),
    sources: normalizeStringList(value.sources, MAX_SOURCES, MAX_SOURCE_CHARS),
    original: value,
  };
}

export function parseStructuredAgentMessage(
  text: string,
  complete = true,
): StructuredAgentMessage | null {
  const candidate = text.trim();
  if (
    !complete
    || candidate.length === 0
    || candidate.length > MAX_STRUCTURED_MESSAGE_CHARS
    || candidate.startsWith("```")
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null;
  }

  if (!isJsonObject(parsed) && !Array.isArray(parsed)) return null;
  if (isJsonObject(parsed)) {
    const envelope = normalizeEnvelope(parsed);
    if (envelope) return { kind: "envelope", raw: candidate, value: envelope };
  }
  return { kind: "json", raw: candidate, value: parsed as JsonObject | JsonValue[] };
}

export function suggestionLabel(command: string): string {
  const normalized = command.trim();
  const known = SUGGESTION_LABELS[normalized.toLowerCase()];
  if (known) return known;
  const project = normalized.match(/^\/project\s+([a-z0-9-]+)$/i);
  return project ? `查看项目：${project[1]}` : normalized;
}
