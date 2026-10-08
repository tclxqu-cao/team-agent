import { afterEach, describe, expect, it, vi } from "vitest";
import { NativePairingClient } from "../mobile/infrastructure/native-pairing";
import { reconcileDurableQueuedMessages } from "../../../desktop/renderer/lib/queued-message-order";

const nativeTimeout = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
const nativeArrayMethods = ["at", "findLast", "findLastIndex"].map((name) => [
  name, Object.getOwnPropertyDescriptor(Array.prototype, name)!,
] as const);
const nativeClone = Object.getOwnPropertyDescriptor(globalThis, "structuredClone")!;

afterEach(() => {
  Object.defineProperty(AbortSignal, "timeout", nativeTimeout);
  for (const [name, descriptor] of nativeArrayMethods) {
    Object.defineProperty(Array.prototype, name, descriptor);
  }
  Object.defineProperty(globalThis, "structuredClone", nativeClone);
  vi.useRealTimers();
});

describe("legacy WebView startup compatibility", () => {
  it("allows QR pairing and shared message rendering when newer browser APIs are missing", async () => {
    Reflect.deleteProperty(AbortSignal, "timeout");
    for (const [name] of nativeArrayMethods) Reflect.deleteProperty(Array.prototype, name);
    Reflect.deleteProperty(globalThis, "structuredClone");
    const { installBrowserCompatibility } = await import("./browser-compatibility");
    installBrowserCompatibility();
    vi.useFakeTimers();

    const storage = { get: vi.fn(), set: vi.fn(), remove: vi.fn() };
    const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ token: "t".repeat(43) })));
    const client = new NativePairingClient(storage, transport);
    const endpoint = await client.pair(JSON.stringify({
      type: "agentroam-pair", version: 1, server: "http://localhost:3000", grant: "g".repeat(43),
    }));
    expect(endpoint.url).toBe("http://localhost:3000");
    expect(storage.set).toHaveBeenCalledWith(endpoint.url, "t".repeat(43));
    expect(transport.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);

    const messages = reconcileDurableQueuedMessages([], {
      active: { id: "queue-1", kind: "message", objective: "hello", createdAt: 1 },
      queued: [], history: [],
    });
    expect(messages.findLast((message) => message.role === "user")?.content).toBe("hello");
    expect(messages.at(-1)?.sendState).toBe("pending");
    const clone = structuredClone(messages);
    expect(clone).toEqual(messages);
    expect(clone).not.toBe(messages);
    vi.runOnlyPendingTimers();
  });

  it("keeps native timeout support intact", async () => {
    const { installBrowserCompatibility } = await import("./browser-compatibility");
    installBrowserCompatibility();
    expect(AbortSignal.timeout).toBe(nativeTimeout.value);
  });

  it("aborts pending pairing requests on an older WebView", async () => {
    Reflect.deleteProperty(AbortSignal, "timeout");
    const { installBrowserCompatibility } = await import("./browser-compatibility");
    installBrowserCompatibility();
    vi.useFakeTimers();
    const signal = AbortSignal.timeout(10_000);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(9_999);
    expect(signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal.aborted).toBe(true);
    expect(signal.reason.name).toBe("TimeoutError");
  });
});
