import type { AgentType } from "./types.js";
import { RuntimeSessionError } from "./types.js";

const PREFIX = "runtime:";
const AGENT_TYPES = new Set<AgentType>([
  "customer-agent",
  "codex",
  "claude-code",
  "opencode",
]);

export function encodeUnifiedSessionId(
  agentType: AgentType,
  nativeSessionId: string,
): string {
  if (!nativeSessionId) {
    throw new RuntimeSessionError("Native session ID is required", "INVALID_SESSION_ID");
  }
  const encoded = Buffer.from(nativeSessionId, "utf8").toString("base64url");
  return `${PREFIX}${agentType}:${encoded}`;
}

export function decodeUnifiedSessionId(
  id: string,
): { agentType: AgentType; nativeSessionId: string } {
  if (!id) {
    throw new RuntimeSessionError("Session ID is required", "INVALID_SESSION_ID");
  }

  if (!id.startsWith(PREFIX)) {
    return { agentType: "customer-agent", nativeSessionId: id };
  }

  const match = /^runtime:([^:]+):([A-Za-z0-9_-]+)$/.exec(id);
  if (!match || !AGENT_TYPES.has(match[1] as AgentType)) {
    throw new RuntimeSessionError(`Invalid unified session ID: ${id}`, "INVALID_SESSION_ID");
  }

  const encoded = match[2];
  const nativeSessionId = Buffer.from(encoded, "base64url").toString("utf8");
  if (!nativeSessionId || Buffer.from(nativeSessionId, "utf8").toString("base64url") !== encoded) {
    throw new RuntimeSessionError(`Invalid unified session ID: ${id}`, "INVALID_SESSION_ID");
  }

  return { agentType: match[1] as AgentType, nativeSessionId };
}
