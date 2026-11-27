import type { ChildProcessWithoutNullStreams } from "node:child_process";
import WebSocket from "ws";
export declare function createCodexDesktopWebSocket(url: string, handshakeTimeoutMs: number): WebSocket;
export declare function createCodexProxyWebSocket(child: ChildProcessWithoutNullStreams, handshakeTimeoutMs: number): WebSocket;
//# sourceMappingURL=codex-app-server-websocket.d.ts.map