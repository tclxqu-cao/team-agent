import { homedir } from "node:os";
import { join } from "node:path";

/**
 * AI Hub relay wire contract, shared by the three ends of the protocol:
 * the desktop Unix-socket server (desktop/main/ai-hub/relay.ts), the
 * server-side pre-validation (ws-server aihub:* handlers), and the
 * server-side client (server/lib/ai-hub-relay-client.mjs). The socket
 * directory follows the native-runtime broker convention so both ends
 * align without extra configuration.
 */
export const AI_HUB_RELAY_SOCKET_NAME = "ai-hub-relay.sock";
export const MAX_RELAY_TEXT_LENGTH = 20_000;
export const MAX_RELAY_SITES = 8;
export const MAX_RELAY_IMAGES = 4;
export const MAX_RELAY_IMAGE_LENGTH = 4_000_000; // base64 字符数上限（约 3MB 二进制）

export function resolveAiHubRelayDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return env.AGENT_NATIVE_RUNTIME_DIR?.trim() || join(homedir(), ".agentroam", "native-runtime");
}

export function resolveAiHubRelaySocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveAiHubRelayDirectory(env), AI_HUB_RELAY_SOCKET_NAME);
}
