import { describe, expect, it, vi } from "vitest";
import { fetchAvailableModels, normalizeModelEndpoint } from "./model-discovery.js";

describe("model discovery", () => {
  it("normalizes host, v1, and full models URLs for the Core provider", () => {
    expect(normalizeModelEndpoint("https://models.example.com")).toMatchObject({
      baseUrl: "https://models.example.com",
      modelsUrl: "https://models.example.com/v1/models",
    });
    expect(normalizeModelEndpoint("https://models.example.com/v1/")).toMatchObject({
      baseUrl: "https://models.example.com",
      modelsUrl: "https://models.example.com/v1/models",
    });
    expect(normalizeModelEndpoint("https://models.example.com/api/v1/models")).toMatchObject({
      baseUrl: "https://models.example.com/api",
      modelsUrl: "https://models.example.com/api/v1/models",
    });
  });

  it("fetches, deduplicates, and naturally sorts OpenAI-compatible models", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "gpt-10" }, { id: "gpt-2" }, { id: "gpt-2" }, {}],
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await fetchAvailableModels({
      baseUrl: "https://models.example.com/v1",
      apiKey: "secret-key",
      fetch: request as typeof fetch,
    });

    expect(result.models).toEqual(["gpt-2", "gpt-10"]);
    expect(request).toHaveBeenCalledWith("https://models.example.com/v1/models", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ Authorization: "Bearer secret-key" }),
    }));
  });

  it("reports response errors without exposing credentials", async () => {
    const request = vi.fn(async () => new Response("denied", { status: 401 }));
    try {
      await fetchAvailableModels({
        baseUrl: "https://models.example.com",
        apiKey: "do-not-leak",
        fetch: request as typeof fetch,
      });
      throw new Error("expected model discovery to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("HTTP 401");
      expect((error as Error).message).not.toContain("do-not-leak");
    }
  });
});
