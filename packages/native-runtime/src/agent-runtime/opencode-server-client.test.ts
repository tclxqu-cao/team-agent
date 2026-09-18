import { describe, expect, it, vi } from "vitest";
import type { GlobalEvent, OpencodeClient } from "@opencode-ai/sdk";
import {
  OpenCodeServerClient,
  subscribeToOpenCodeEvents,
} from "./opencode-server-client.js";

const connectedEvent = {
  directory: "/repo",
  payload: { type: "server.connected", properties: {} },
} as GlobalEvent;

const idleEvent = {
  directory: "/repo",
  payload: { type: "session.idle", properties: { sessionID: "ses_1" } },
} as GlobalEvent;

function eventClient(...streams: AsyncIterable<GlobalEvent>[]) {
  const event = vi.fn(async () => ({ stream: streams.shift()! }));
  return {
    client: { global: { event } } as unknown as OpencodeClient,
    event,
  };
}

async function* events(...values: GlobalEvent[]): AsyncGenerator<GlobalEvent> {
  for (const value of values) yield value;
}

describe("OpenCodeServerClient", () => {
  it("reports a missing executable without waiting for the health timeout", async () => {
    const client = new OpenCodeServerClient({ executable: "/definitely/missing/agentroam-opencode" });
    const started = Date.now();
    await expect(client.client()).rejects.toThrow(/ENOENT|missing/i);
    expect(Date.now() - started).toBeLessThan(2_000);
    await client.dispose();
  });

  it("isolates a malformed event handler failure and keeps consuming the stream", async () => {
    const fixture = eventClient(events(connectedEvent, idleEvent));
    const received: GlobalEvent[] = [];
    const eventErrors: Error[] = [];
    const stop = subscribeToOpenCodeEvents(fixture.client, {
      onEvent: (event) => {
        if (event === connectedEvent) throw new Error("malformed event");
        received.push(event);
      },
      onEventError: (error) => eventErrors.push(error),
      onFailure: vi.fn(),
    });

    await vi.waitFor(() => expect(received).toEqual([idleEvent]));
    expect(eventErrors[0]?.message).toBe("malformed event");
    expect(fixture.event).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reconnects after the global event stream ends unexpectedly", async () => {
    let releaseSecondStream!: () => void;
    async function* secondStream(): AsyncGenerator<GlobalEvent> {
      yield idleEvent;
      await new Promise<void>((resolve) => { releaseSecondStream = resolve; });
    }
    const fixture = eventClient(events(connectedEvent), secondStream());
    const received: GlobalEvent[] = [];
    const failures: Error[] = [];
    const stop = subscribeToOpenCodeEvents(fixture.client, {
      onEvent: (event) => received.push(event),
      onEventError: vi.fn(),
      onFailure: (error) => failures.push(error),
      reconnectDelayMs: () => 0,
    });

    await vi.waitFor(() => expect(received).toEqual([connectedEvent, idleEvent]));
    expect(fixture.event).toHaveBeenCalledTimes(2);
    expect(failures[0]?.message).toBe("OpenCode event stream ended unexpectedly");
    stop();
    releaseSecondStream();
  });
});
