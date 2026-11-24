import { describe, expect, it } from "vitest";
import type { AgentWorkspace } from "../../../../shared/src/contracts/agent-api";
import { resolveTaskDraftWorkspace } from "./session-state";

const first: AgentWorkspace = { agentType: "customer-agent", workspaceId: "first", name: "first", roots: ["/first"], source: "native", order: 0 };
const target: AgentWorkspace = { ...first, workspaceId: "target", name: "target", roots: ["/target"] };

describe("new-session directory resolution", () => {
  it("waits for a later page instead of creating in the first unrelated directory", () => {
    const draft = { agentType: "customer-agent" as const, projectId: null, cwd: "/target" };
    expect(resolveTaskDraftWorkspace(draft, [first], false)).toBeUndefined();
    expect(resolveTaskDraftWorkspace(draft, [first, target], true)).toBe(target);
  });

  it("only falls back after discovery finishes and skips directories that cannot create sessions", () => {
    const draft = { agentType: "customer-agent" as const, projectId: null, cwd: "/missing" };
    expect(resolveTaskDraftWorkspace(draft, [{ ...target, canCreateSession: false }, first], true)).toBe(first);
  });

  it("preserves the chosen directory when another matching path appears", () => {
    const draft = { agentType: "customer-agent" as const, projectId: "target", cwd: "/first" };
    expect(resolveTaskDraftWorkspace(draft, [first, target], false)).toBe(target);
  });
});
