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
});
