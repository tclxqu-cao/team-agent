import { describe, expect, it } from "vitest";
import { HttpConnectivityProbe } from "./http-connectivity-probe";
import { ServerEndpoint } from "../domain/server-endpoint";

const endpoint = ServerEndpoint.parse("http://10.0.0.5:3000")!;

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe("HttpConnectivityProbe", () => {
  it("hits /api/agent/model on the endpoint origin and reports the model", async () => {
    const calls: [RequestInfo | URL, RequestInit?][] = [];
    const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return okResponse({ provider: "openai", modelId: "glm-4" });
    }) as typeof fetch;

    const result = await new HttpConnectivityProbe(transport).probe(endpoint);

    expect(result).toEqual({ ok: true, modelId: "glm-4" });
    expect(calls[0][0]).toBe("http://10.0.0.5:3000/api/agent/model");
    expect(calls[0][1]?.cache).toBe("no-store");
  });

  it("maps HTTP errors to a failure reason", async () => {
    const transport = (async () =>
      ({ ok: false, status: 502, json: async () => ({}) }) as unknown as Response) as typeof fetch;

    await expect(new HttpConnectivityProbe(transport).probe(endpoint)).resolves.toEqual({
      ok: false,
      reason: "HTTP 502",
    });
  });

  it("distinguishes timeouts from other network failures", async () => {
    const abort = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;
    const offline = (async () => {
      throw new TypeError("load failed");
    }) as typeof fetch;

    await expect(new HttpConnectivityProbe(abort).probe(endpoint)).resolves.toEqual({ ok: false, reason: "连接超时" });
    await expect(new HttpConnectivityProbe(offline).probe(endpoint)).resolves.toEqual({ ok: false, reason: "load failed" });
  });
});
