import { describe, expect, it } from "vitest";
import { AGENT_TYPES, NATIVE_AGENT_TYPES, isAgentType, isNativeAgentType } from "./agent-type";

describe("Agent type registry", () => {
  it("keeps all eight independent Agents in stable order", () => {
    expect(AGENT_TYPES).toEqual(["customer-agent", "codex", "claude-code", "opencode", "deepseek-harness", "qoder", "zcode", "workbuddy"]);
    expect(new Set(AGENT_TYPES).size).toBe(8);
    expect(NATIVE_AGENT_TYPES).toEqual(AGENT_TYPES.filter(type => type !== "customer-agent"));
  });

  it.each(AGENT_TYPES)("validates %s without conflating CA and native runtimes", type => {
    expect(isAgentType(type)).toBe(true);
    expect(isNativeAgentType(type)).toBe(type !== "customer-agent");
  });

  it.each([null, undefined, 1, {}, [], "", "Qoder", "workboddy", "unknown"])("rejects an unknown Agent %j", value => {
    expect(isAgentType(value)).toBe(false);
    expect(isNativeAgentType(value)).toBe(false);
  });
});
