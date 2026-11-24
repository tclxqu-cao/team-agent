import { useState } from "react";
import TerminalPane from "../../../../shared/src/console/TerminalPane";
import { resolveWebTheme } from "../../../../shared/src/console/themes";
import { useGateway, type GatewaySocket } from "../../../../shared/src/console/useGateway";
import { useUIStore } from "../../stores/uiStore";
import type { SharedServiceApi } from "../../lib/shared-service";

type DesktopTerminalTransport = NonNullable<SharedServiceApi["terminalSocket"]>;

function desktopTerminalSocket(transport: DesktopTerminalTransport): GatewaySocket {
  const id = crypto.randomUUID();
  let readyState: number = WebSocket.CONNECTING;
  const finish = (code: number) => {
    if (readyState === WebSocket.CLOSED) return;
    readyState = WebSocket.CLOSED;
    unsubscribe();
    void transport.close(id).catch(() => {});
    socket.onclose?.(new CloseEvent("close", { code }));
  };
  const socket: GatewaySocket = {
    get readyState() { return readyState; },
    binaryType: "arraybuffer",
    onopen: null, onmessage: null, onclose: null, onerror: null,
    send: data => { if (readyState === WebSocket.OPEN) void transport.send(id, data).catch(() => {}); },
    close: () => finish(1000),
  };
  const unsubscribe = transport.onFrame(frame => {
    if (frame.id !== id) return;
    if (frame.type === "open") {
      readyState = WebSocket.OPEN;
      socket.onopen?.(new Event("open"));
    } else if (frame.type === "close") {
      finish(frame.code);
    } else if (readyState === WebSocket.OPEN) {
      const data = typeof frame.data === "string" ? frame.data : new Uint8Array(frame.data).buffer;
      socket.onmessage?.(new MessageEvent("message", { data }));
    }
  });
  void transport.open(id).catch(() => finish(4001));
  return socket;
}

async function webTerminalNonce(): Promise<string> {
  const response = await fetch("/api/web-console/bootstrap", { credentials: "same-origin", cache: "no-store" });
  if (!response.ok) throw new Error("终端连接验证失败");
  const { wsNonce } = await response.json() as { wsNonce?: string };
  if (!wsNonce) throw new Error("终端连接验证失败");
  return wsNonce;
}

interface PaneProps { paneId: string; active: boolean; focused: boolean }

function ConnectedTerminal({ paneId, active, focused, transport }: PaneProps & { transport?: DesktopTerminalTransport }) {
  const skin = useUIStore(state => state.skin);
  const [keyOrder, setKeyOrder] = useState<string[]>([]);
  const [keybarHidden, setKeybarHidden] = useState(true);
  const [authError, setAuthError] = useState(false);
  const gateway = useGateway(() => {}, webTerminalNonce, () => setAuthError(true),
    transport ? () => desktopTerminalSocket(transport) : undefined);

  return <div className="task-pane-terminal">
    <TerminalPane terminalId={`t-split-${paneId}`} title="分屏终端" visible={active} autoFocus={focused}
      state={gateway.state} rpc={gateway.rpc} onEvent={gateway.onEvent}
      onTerminalData={gateway.onTerminalData} onTerminalReset={gateway.onTerminalReset} sendTerminalInput={gateway.sendTerminalInput}
      keyOrder={keyOrder} keybarHidden={keybarHidden} onKeyOrderChange={setKeyOrder} onKeybarHiddenChange={setKeybarHidden}
      terminalTheme={resolveWebTheme(skin)} />
    {!gateway.state.connected && <div className="task-pane-terminal-connection" role={authError || gateway.state.error ? "alert" : "status"}>
      {authError || gateway.state.error ? <>
        <span>无法连接本机终端</span>
        <button type="button" onClick={() => { setAuthError(false); void gateway.reconnect(); }}>重试</button>
      </> : "正在连接本机终端"}
    </div>}
  </div>;
}

export default function TaskPaneTerminal(props: PaneProps) {
  const service = typeof window === "undefined" ? undefined : window.sharedServiceApi;
  if (service && !service.terminalSocket) return <div className="task-pane-terminal-connection" role="status">请更新桌面端以连接本机终端</div>;
  return <ConnectedTerminal {...props} transport={service?.terminalSocket} />;
}
