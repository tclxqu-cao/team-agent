import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "./AgentClient";

describe("AgentClient remote tools", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("registers remote tools with the agent server", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new AgentClient({ server: "http://agent", token: "sdk-token" });

    await client.registerRemoteTools("kid-earth-learning", [
      {
        scheme: "create_kid_earth_course",
        purpose: "创建课程",
        url: "http://kid/api/agent-actions/create-course",
        method: "POST",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent/api/remote-tools/register",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sdk-token" }),
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      projectId: "kid-earth-learning",
      tools: [{ scheme: "create_kid_earth_course" }],
    });
  });
});
