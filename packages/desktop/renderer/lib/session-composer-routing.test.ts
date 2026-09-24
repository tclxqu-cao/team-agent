import { describe, expect, it } from "vitest";
import type { UnifiedSessionSummary } from "../global";
import { resolveSessionComposerRoute } from "./session-composer-routing";

const codexSession = { id: "codex-session", agentType: "codex" } as UnifiedSessionSummary;

describe("resolveSessionComposerRoute", () => {
  it("waits when a selected session summary is unresolved", () => {
    expect(resolveSessionComposerRoute("codex-session", undefined, "customer-agent"))
      .toEqual({ agentType: "customer-agent", ready: false });
  });

  it("waits when the summary still belongs to the previous session", () => {
    const previous = { id: "ca-session", agentType: "customer-agent" } as UnifiedSessionSummary;
    expect(resolveSessionComposerRoute("codex-session", previous, "customer-agent"))
      .toEqual({ agentType: "customer-agent", ready: false });
  });

  it("uses the matching session agent type", () => {
    expect(resolveSessionComposerRoute("codex-session", codexSession, "customer-agent"))
      .toEqual({ agentType: "codex", ready: true });
  });

  it("uses the active agent for a new session", () => {
    expect(resolveSessionComposerRoute(null, undefined, "codex"))
      .toEqual({ agentType: "codex", ready: true });
  });
});
