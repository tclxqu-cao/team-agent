import { describe, expect, it } from "vitest";
import { AGENT_TYPES } from "../../../core/src/domain/agent/agent-type";
import { AGENT_LABELS } from "./agent-catalog";
import { agentUnavailableMessage } from "./agent-availability";

describe("Agent availability feedback", () => {
  const nativeAgents = AGENT_TYPES.filter(agentType => agentType !== "customer-agent");

  it.each(nativeAgents)("blocks an uninstalled %s with an explicit installation notice", agentType => {
    expect(agentUnavailableMessage(agentType, [{ agentType, available: false, label: AGENT_LABELS[agentType], error: "CLI not installed" }]))
      .toBe(`远程未安装 ${AGENT_LABELS[agentType]}`);
  });

  it.each(nativeAgents)("keeps %s blocked until its runtime has been checked", agentType => {
    expect(agentUnavailableMessage(agentType, [])).toContain("正在检查远程");
  });

  it.each(AGENT_TYPES)("allows an available %s", agentType => {
    expect(agentUnavailableMessage(agentType, [{ agentType, available: true, label: AGENT_LABELS[agentType] }])).toBeUndefined();
  });

  it("keeps the built-in Agent available while native health is loading", () => {
    expect(agentUnavailableMessage("customer-agent", [])).toBeUndefined();
  });

  it("distinguishes an installed but unusable runtime from a missing installation", () => {
    expect(agentUnavailableMessage("workbuddy", [{ agentType: "workbuddy", available: false, label: "WorkBuddy", error: "native login required" }]))
      .toBe("远程 WorkBuddy 暂不可用");
  });
});
