import { describe, expect, it } from "vitest";
import { agentHost } from "./agent-host";

describe("agentHost singleton", () => {
  it("stores the shared AgentHost on globalThis so answer routes can see pending questions from run routes", () => {
    expect((globalThis as unknown as { __agentHost?: unknown }).__agentHost).toBe(agentHost);
  });
});
