import { describe, expect, it } from "vitest";
import { agentHost } from "./agent-host";
import { POST as registerRemoteTools } from "./remote-tools/register/route";

describe("agentHost singleton", () => {
  it("stores the shared AgentHost on globalThis so answer routes can see pending questions from run routes", () => {
    expect((globalThis as unknown as { __agentHost?: unknown }).__agentHost).toBe(agentHost);
  });

  it("registers remote tools through the server route", async () => {
    const response = await registerRemoteTools(new Request("http://test/api/remote-tools/register", {
      method: "POST",
      headers: { authorization: "Bearer test-token" },
      body: JSON.stringify({ projectId: "kid-earth-learning", tools: [{ scheme: "create_kid_earth_course", purpose: "创建课程", url: "http://kid/api/agent-actions/create-course", method: "POST" }] }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, tools: [{ scheme: "create_kid_earth_course" }] });
  });
});
