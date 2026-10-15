import { afterEach, describe, expect, it, vi } from "vitest";
import { nativeFrameBridge, nativeFrameFetch } from "./native-frame-bridge";

afterEach(() => vi.unstubAllGlobals());
describe("bundled native workspace frames", () => {
  it("inherits transport only from a same-host parent for an explicit workspace frame", () => {
    const bridge = { origin: "https://computer.example", fetch: vi.fn() };
    vi.stubGlobal("location", { protocol: "capacitor:", host: "localhost", search: "?workspace=1" });
    vi.stubGlobal("window", { parent: { location: { href: "capacitor://localhost/index.html" }, __agentroamNativeFrame: bridge } });
    expect(nativeFrameBridge()).toBe(bridge);
    window.parent.location.href = "capacitor://other/index.html";
    expect(nativeFrameBridge()).toBeNull();
    window.parent.location.href = "capacitor://localhost/index.html";
    vi.stubGlobal("location", { protocol: "capacitor:", host: "localhost", search: "" });
    expect(nativeFrameBridge()).toBeNull();
  });
  it("forwards requests and aborts without relying on child native plugins", async () => {
    const response = new Response("stream");
    const transport = vi.fn(async (_url: string, _init?: RequestInit) => response);
    const fetch = nativeFrameFetch({ origin: "https://computer.example", fetch: transport });
    const controller = new AbortController();
    const result = await fetch(new Request("https://computer.example/api/settings", { method: "POST", body: "{}", headers: { "content-type": "application/json" }, signal: controller.signal }));
    expect(result).toBe(response);
    expect(transport.mock.calls[0][0]).toBe("https://computer.example/api/settings");
    const init = transport.mock.calls[0][1]!;
    expect(init.method).toBe("POST");
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe("{}");
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });
});
