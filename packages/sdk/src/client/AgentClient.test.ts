import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentClient } from "./AgentClient";

describe("AgentClient remote tools", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("serializes shared Agent, Skill, profile and Session metadata on a run", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runId: "run-1" }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = class {
      onmessage = null;
      onerror = null;
      close() {}
    } as unknown as typeof EventSource;
    try {
      const client = new AgentClient({ server: "http://agent", token: "sdk-token" });
      await client.run("show works", "session-1", {
        agentId: "portfolio-content-agent",
        skillName: "portfolio-works",
        profileId: "aihub-deepseek",
        projectId: "portfolio",
        title: "Portfolio: works",
        metadata: { flowId: "homepage-main" },
        context: { intent: "works" },
        source: "flow-studio",
      });

      const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
      const runCall = calls.find(([url]) => String(url).endsWith("/api/agent/run"));
      expect(JSON.parse(String(runCall?.[1].body))).toEqual({
        input: "show works",
        sessionId: "session-1",
        source: "flow-studio",
        agentId: "portfolio-content-agent",
        skillName: "portfolio-works",
        profileId: "aihub-deepseek",
        projectId: "portfolio",
        title: "Portfolio: works",
        metadata: { flowId: "homepage-main" },
        context: { intent: "works" },
      });
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });

  it("registers remote tools with the normal SDK token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new AgentClient({ server: "http://agent", token: "sdk-token" });

    await client.registerRemoteTools("remote-tools-test-project", [
      {
        scheme: "create_kid_earth_course",
        purpose: "创建课程",
        url: "http://kid/api/agent-actions/create-course",
        method: "POST",
        headers: { "X-Project": "kid-earth" },
        inputSchema: { type: "object", properties: { title: { type: "string" } } },
        outputSchema: { type: "object" },
        examples: [{ title: "Earth" }],
        auth: { type: "bearer" },
      },
      {
        scheme: "create_defaulted_tool",
        purpose: "默认字段测试",
        url: "http://kid/api/defaulted",
      },
    ]);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent/api/remote-tools/register",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer sdk-token" }),
      }),
    );
    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const requestInit = fetchCalls[0][1];
    expect(JSON.parse(String(requestInit.body))).toEqual({
      projectId: "remote-tools-test-project",
      tools: [
        {
          scheme: "create_kid_earth_course",
          purpose: "创建课程",
          url: "http://kid/api/agent-actions/create-course",
          method: "POST",
          headers: { "X-Project": "kid-earth" },
          inputSchema: { type: "object", properties: { title: { type: "string" } } },
          outputSchema: { type: "object" },
          examples: [{ title: "Earth" }],
          auth: { type: "bearer" },
        },
        {
          scheme: "create_defaulted_tool",
          purpose: "默认字段测试",
          url: "http://kid/api/defaulted",
          method: "POST",
          headers: {},
          inputSchema: {},
          outputSchema: {},
          examples: [],
          auth: {},
        },
      ],
    });
  });

  it("passes projectId when creating sessions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "session-1" }), { status: 201 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new AgentClient({ server: "http://agent", token: "sdk-token" });

    await client.createSession("课程创建", "kid-earth-learning");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "课程创建", projectId: "kid-earth-learning" }),
      }),
    );
  });

  it("passes projectId when listing sessions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([]), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    const client = new AgentClient({ server: "http://agent", token: "sdk-token" });

    await client.listSessions("kid-earth-learning");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://agent/api/sessions?projectId=kid-earth-learning",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer sdk-token" }) }),
    );
  });
});
