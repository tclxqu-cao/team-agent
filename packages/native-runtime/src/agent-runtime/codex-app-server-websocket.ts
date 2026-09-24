import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Duplex } from "node:stream";
import WebSocket from "ws";

type ProxySocket = Duplex & {
  connecting: boolean;
  setKeepAlive(enable?: boolean, initialDelay?: number): ProxySocket;
  setNoDelay(noDelay?: boolean): ProxySocket;
  setTimeout(timeout: number, callback?: () => void): ProxySocket;
};

export function createCodexProxyWebSocket(
  child: ChildProcessWithoutNullStreams,
  handshakeTimeoutMs: number,
): WebSocket {
  const socket = Duplex.from({
    readable: child.stdout,
    writable: child.stdin,
  }) as ProxySocket;
  let timeoutTimer: NodeJS.Timeout | null = null;
  socket.connecting = false;
  socket.setKeepAlive = () => socket;
  socket.setNoDelay = () => socket;
  socket.setTimeout = (timeout, callback) => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timeoutTimer = null;
    if (callback) socket.once("timeout", callback);
    if (timeout > 0) {
      timeoutTimer = setTimeout(() => socket.emit("timeout"), timeout);
      timeoutTimer.unref();
    }
    return socket;
  };
  socket.once("close", () => {
    if (timeoutTimer) clearTimeout(timeoutTimer);
  });

  return new WebSocket("ws://localhost/", {
    createConnection: (() => socket) as never,
    handshakeTimeout: handshakeTimeoutMs,
    perMessageDeflate: false,
  });
}
