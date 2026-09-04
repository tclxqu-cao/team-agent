import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, HttpClient } from "./http-client";

describe("HttpClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves a structured runtime error code", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      error: "Session is already running",
      code: "SESSION_ALREADY_RUNNING",
    }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }));

    const request = new HttpClient().post("/api/agent/run", {});

    await expect(request).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
      code: "SESSION_ALREADY_RUNNING",
      message: "Session is already running",
    } satisfies Partial<ApiError>);
  });
});
