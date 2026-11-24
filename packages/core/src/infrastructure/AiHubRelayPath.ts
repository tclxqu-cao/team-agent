import { homedir } from "node:os";
import { join } from "node:path";
import { AI_HUB_RELAY_SOCKET_NAME } from "../domain/ai-hub/relay-protocol.js";

export function resolveAiHubRelayDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_NATIVE_RUNTIME_DIR?.trim() || join(homedir(), ".agentroam", "native-runtime");
}

export function resolveAiHubRelaySocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAiHubRelayDirectory(env), AI_HUB_RELAY_SOCKET_NAME);
}
