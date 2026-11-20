import { describe, expect, it, vi } from "vitest";
import { WEBAPP_BROWSER_BINARY_FRAME_TYPE, WEBAPP_BROWSER_EVENT_TYPE, WEBAPP_BROWSER_RESPONSE_TYPE } from "../../../core/src/domain/web-console/WebBrowserBridge";
import { WebShellBrowserBridge } from "./web-shell-browser-bridge";

function fixture() {
  let listener: ((event: MessageEvent) => void) | null = null;
  const parent = { postMessage: vi.fn() };
  const context = {
    location: { origin: "https://agentroam.local" },
    parent,
    addEventListener: vi.fn((_type: string, next: EventListener) => { listener = next as (event: MessageEvent) => void; }),
    removeEventListener: vi.fn(),
  };
  return { context, parent, emit: (data: unknown) => listener?.({ data, origin: context.location.origin, source: parent } as unknown as MessageEvent) };
}

describe("WebShellBrowserBridge", () => {
  it("reads the desktop lock state without claiming a control lease", async () => {
    const { context, parent } = fixture();
    const bridge = new WebShellBrowserBridge(context as never);
    const fetchStatus = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ online: true, locked: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ online: true, locked: false })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ online: false, locked: true })));
    vi.stubGlobal("fetch", fetchStatus);
    try {
      const { signal } = new AbortController();
      await expect(bridge.readDesktopLockState(signal)).resolves.toBe(true);
      await expect(bridge.readDesktopLockState(signal)).resolves.toBe(false);
      await expect(bridge.readDesktopLockState(signal)).resolves.toBeNull();
      expect(fetchStatus).toHaveBeenCalledWith("/api/remote-authorization/status", { credentials: "same-origin", cache: "no-store", signal });
      expect(parent.postMessage).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      bridge.dispose();
    }
  });

  it("rejects stale control requests and discards channel mappings on reconnect", async () => {
    const { context, parent, emit } = fixture();
    const bridge = new WebShellBrowserBridge(context as never);
    const observer = vi.fn();
    bridge.onEvent(observer);
    const watching = bridge.request("browser:watch", { sessionId: "old" });
    const sent = parent.postMessage.mock.calls[0][0];
    emit({ type: WEBAPP_BROWSER_RESPONSE_TYPE, id: sent.id, ok: true, result: { channelId: 8, session: { id: "old" } } });
    await watching;
    const input = bridge.request("browser:input", { sessionId: "old" });
    const rejected = expect(input).rejects.toMatchObject({ code: "EOFFLINE" });
    emit({ type: WEBAPP_BROWSER_EVENT_TYPE, event: { type: "browser:connection", connected: false } });
    await rejected;
    observer.mockClear();
    emit({ type: WEBAPP_BROWSER_BINARY_FRAME_TYPE, channelId: 8, sequence: 1, data: new ArrayBuffer(1) });
    expect(observer).not.toHaveBeenCalled();
    bridge.dispose();
  });
  it("correlates browser requests with shell responses", async () => {
    const { context, parent, emit } = fixture();
    const bridge = new WebShellBrowserBridge(context as never);
    const request = bridge.request<{ sessions: unknown[] }>("browser:list");
    const sent = parent.postMessage.mock.calls[0][0];
    emit({ type: WEBAPP_BROWSER_RESPONSE_TYPE, id: sent.id, ok: true, result: { sessions: [] } });
    await expect(request).resolves.toEqual({ sessions: [] });
  });

  it("fans live browser events out to subscribers", () => {
    const { context, parent, emit } = fixture();
    const bridge = new WebShellBrowserBridge(context as never);
    const observer = vi.fn();
    bridge.onEvent(observer);
    emit({ type: WEBAPP_BROWSER_EVENT_TYPE, event: { type: "browser:frame", sequence: 7 } });
    expect(observer).toHaveBeenCalledWith({ type: "browser:frame", sequence: 7 });
    expect(parent.postMessage).not.toHaveBeenCalled();
  });

  it("maps transferred binary channels back to browser sessions", async () => {
    const { context, parent, emit } = fixture();
    const bridge = new WebShellBrowserBridge(context as never);
    const observer = vi.fn();
    bridge.onEvent(observer);
    const watching = bridge.request("browser:watch", { sessionId: "browser-1" });
    const sent = parent.postMessage.mock.calls[0][0];
    emit({ type: WEBAPP_BROWSER_RESPONSE_TYPE, id: sent.id, ok: true, result: { channelId: 8, session: { id: "browser-1" } } });
    await watching;
    const data = new ArrayBuffer(24);
    emit({ type: WEBAPP_BROWSER_BINARY_FRAME_TYPE, channelId: 8, sequence: 11, data });
    expect(observer).toHaveBeenCalledWith(expect.objectContaining({ type: "browser:frame", sessionId: "browser-1", sequence: 11, data }));
  });

  it("replays a frame that crosses the iframe boundary before the watch response", async () => {
    const { context, parent, emit } = fixture();
    const bridge = new WebShellBrowserBridge(context as never);
    const observer = vi.fn();
    bridge.onEvent(observer);
    const watching = bridge.request("browser:watch", { sessionId: "browser-1" });
    const sent = parent.postMessage.mock.calls[0][0];
    const data = new ArrayBuffer(24);

    emit({ type: WEBAPP_BROWSER_BINARY_FRAME_TYPE, channelId: 8, sequence: 12, data });
    expect(observer).not.toHaveBeenCalled();
    emit({ type: WEBAPP_BROWSER_RESPONSE_TYPE, id: sent.id, ok: true, result: { channelId: 8, session: { id: "browser-1" } } });
    await watching;

    expect(observer).toHaveBeenCalledWith(expect.objectContaining({
      type: "browser:frame",
      sessionId: "browser-1",
      sequence: 12,
      data,
    }));
  });

  it("distinguishes the preview channel from the control channel for the same desktop", async () => {
    const { context, parent, emit } = fixture();
    const bridge = new WebShellBrowserBridge(context as never);
    const observer = vi.fn();
    bridge.onEvent(observer);
    const session = { id: "cli-desktop:primary" };
    const control = bridge.request("browser:watch", { sessionId: session.id });
    const projection = bridge.request("browser:desktop-watch", { sessionId: session.id });
    const [controlRequest, projectionRequest] = parent.postMessage.mock.calls.map(([request]) => request);
    emit({ type: WEBAPP_BROWSER_RESPONSE_TYPE, id: controlRequest.id, ok: true, result: { channelId: 8, session } });
    emit({ type: WEBAPP_BROWSER_BINARY_FRAME_TYPE, channelId: 9, sequence: 11, data: new ArrayBuffer(1) });
    emit({ type: WEBAPP_BROWSER_RESPONSE_TYPE, id: projectionRequest.id, ok: true, result: { channelId: 9, session } });
    await Promise.all([control, projection]);
    emit({ type: WEBAPP_BROWSER_BINARY_FRAME_TYPE, channelId: 8, sequence: 12, data: new ArrayBuffer(1) });
    expect(observer.mock.calls[0][0]).toMatchObject({ sessionId: session.id, sequence: 11, sessionDesktop: true });
    expect(observer.mock.calls[1][0]).not.toHaveProperty("sessionDesktop");
    bridge.dispose();
  });
});
