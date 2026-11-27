/**
 * AI Hub relay wire contract, shared by the three ends of the protocol:
 * the desktop Unix-socket server (desktop/main/ai-hub/relay.ts), the
 * server-side pre-validation (ws-server aihub:* handlers), and the
 * server-side client (server/lib/ai-hub-relay-client.mjs). The socket
 * directory follows the native-runtime broker convention so both ends
 * align without extra configuration.
 */
export declare const AI_HUB_RELAY_SOCKET_NAME = "ai-hub-relay.sock";
export declare const MAX_RELAY_TEXT_LENGTH = 100000;
export declare const MAX_RELAY_SITES = 8;
export { MAX_RELAY_IMAGES, MAX_RELAY_IMAGE_LENGTH } from "./image-limits";
//# sourceMappingURL=relay-protocol.d.ts.map