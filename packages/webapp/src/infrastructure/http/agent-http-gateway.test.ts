import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHttpGateway } from "./agent-http-gateway";

class FailedEventSource {
  static readonly CLOSED = 2;
  readonly readyState = FailedEventSource.CLOSED;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => this.onerror?.(new Event("error")));
  }

  close(): void {}
}

describe("AgentHttpGateway", () => {
  const originalEventSource = globalThis.EventSource;

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.EventSource = originalEventSource;
  });

  it("settles the run and dispatches an error when the event stream cannot open", async () => {
    globalThis.EventSource = FailedEventSource as unknown as typeof EventSource;
    const http = { post: vi.fn() };
    const settings = { getModelOverride: vi.fn(() => null) };
    const gateway = new AgentHttpGateway(http as never, settings as never);
    const events: unknown[] = [];
    gateway.onEvent((event) => events.push(event));

    await expect(gateway.run("hello", "session-1")).resolves.toEqual([]);

    expect(http.post).not.toHaveBeenCalled();
    expect(events).toContainEqual({
      type: "error",
      message: "事件流连接失败",
      _sid: "session-1",
    });
  });
});
