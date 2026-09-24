import { afterEach, describe, expect, it } from "vitest";
import type { AgentEvent } from "@agent/core";
import {
  FlowProtocolError,
  assertFlowAuthorized,
  flowErrorResponse,
  mapFlowEvent,
  parseFlowRunRequest,
} from "./flow-protocol";

const originalToken = process.env.AGENT_RUN_TOKEN;
const originalPortfolioToken = process.env.PORTFOLIO_SKILL_TOKEN;

afterEach(() => {
  if (originalToken === undefined) delete process.env.AGENT_RUN_TOKEN;
  else process.env.AGENT_RUN_TOKEN = originalToken;
  if (originalPortfolioToken === undefined) delete process.env.PORTFOLIO_SKILL_TOKEN;
  else process.env.PORTFOLIO_SKILL_TOKEN = originalPortfolioToken;
});

describe("parseFlowRunRequest", () => {
  it("accepts bounded Flow instructions without requiring a persistent Agent", () => {
    expect(parseFlowRunRequest({
      input: "hello",
      instructions: "Reply as the configured Flow Agent.",
      selection: { modelId: "profile-1" },
    })).toMatchObject({
      input: "hello",
      instructions: "Reply as the configured Flow Agent.",
      selection: { modelId: "profile-1" },
    });
    expect(() => parseFlowRunRequest({
      input: "hello",
      instructions: "x".repeat(32_001),
    })).toThrow("instructions");
  });

  it("preserves explicit empty capability lists", () => {
    expect(parseFlowRunRequest({
      input: "hello",
      selection: {
        skillIds: [],
        activatedSkillIds: [],
        toolIds: [],
        mcpServerIds: [],
        memoryEnabled: false,
      },
    }).selection).toEqual({
      skillIds: [],
      activatedSkillIds: [],
      toolIds: [],
      mcpServerIds: [],
      memoryEnabled: false,
      modelId: undefined,
    });
  });

  it("preserves the selected server-owned tool policy ID", () => {
    expect(parseFlowRunRequest({
      input: "hello",
      selection: { toolPolicyId: "local-readonly" },
    }).selection.toolPolicyId).toBe("local-readonly");
  });

  it("rejects duplicate IDs and activated Skills outside the allowlist", () => {
    expect(() => parseFlowRunRequest({ input: "x", selection: { toolIds: ["read_file", "read_file"] } }))
      .toThrow("duplicate");
    expect(() => parseFlowRunRequest({
      input: "x",
      selection: { skillIds: ["one"], activatedSkillIds: ["two"] },
    })).toThrow("subset");
  });
});

describe("Flow protocol authentication", () => {
  it("requires the configured service token", () => {
    process.env.AGENT_RUN_TOKEN = "secret";
    expect(() => assertFlowAuthorized(new Request("http://test/api/flow/v1/catalog")))
      .toThrowError(FlowProtocolError);
    expect(() => assertFlowAuthorized(new Request("http://test/api/flow/v1/catalog", {
      headers: { authorization: "Bearer secret" },
    }))).not.toThrow();
  });

  it("uses the portfolio service token when no dedicated run token exists", () => {
    delete process.env.AGENT_RUN_TOKEN;
    process.env.PORTFOLIO_SKILL_TOKEN = "portfolio-secret";
    expect(() => assertFlowAuthorized(new Request("http://test/api/flow/v1/catalog")))
      .toThrowError(FlowProtocolError);
    expect(() => assertFlowAuthorized(new Request("http://test/api/flow/v1/catalog", {
      headers: { authorization: "Bearer portfolio-secret" },
    }))).not.toThrow();
  });
});

describe("flowErrorResponse", () => {
  it("normalizes session conflicts and capability failures", async () => {
    const conflict = flowErrorResponse(Object.assign(new Error("busy"), {
      code: "SESSION_ALREADY_RUNNING",
    }));
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({
      error: "busy", code: "SESSION_OCCUPIED",
    });

    const capability = flowErrorResponse(Object.assign(new Error("not allowed"), {
      code: "SKILL_NOT_ALLOWED",
    }));
    expect(capability.status).toBe(422);
    await expect(capability.json()).resolves.toEqual({
      error: "not allowed", code: "INVALID_CAPABILITY",
    });
  });
});

describe("mapFlowEvent", () => {
  it("maps deltas, tools, completion, and cancellation", () => {
    expect(mapFlowEvent("run", "session", 1, { type: "text_chunk", text: "hi" }))
      .toMatchObject({ event: "assistant.delta", data: { runId: "run", text: "hi" } });
    expect(mapFlowEvent("run", "session", 2, {
      type: "tool_call",
      toolCall: { id: "call", name: "read_file", arguments: { path: "README.md" } },
    } as AgentEvent)).toMatchObject({ event: "tool.started", data: { name: "read_file" } });
    expect(mapFlowEvent("run", "session", 3, {
      type: "done",
      finalText: "finished",
      durationMs: 42,
    })).toMatchObject({ event: "run.completed", data: { text: "finished", durationMs: 42 } });
    expect(mapFlowEvent("run", "session", 4, { type: "turn_aborted" }))
      .toMatchObject({ event: "run.failed", data: { code: "RUN_CANCELLED" } });
  });

  it("ignores non-public internal progress events", () => {
    expect(mapFlowEvent("run", "session", 1, { type: "thinking", message: "private" }))
      .toBeNull();
  });
});
