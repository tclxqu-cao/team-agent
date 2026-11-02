import { describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "../global";
import { createSessionForWorkspace, resolveSessionComposerRoute } from "./session-composer-routing";
import { prepareChatCommand } from "./chat-command";

const codexSession = { id: "codex-session", agentType: "codex" } as UnifiedSessionSummary;

describe("new-session workspace submission", () => {
  it("creates an imported Codex workspace by cwd and keeps the receipt for sidebar selection", async () => {
    const api = { createSession: vi.fn().mockImplementation(async (_title, projectId, agentType, cwd) => {
      if (projectId) throw new Error(`project not found: ${projectId}`);
      return { ...codexSession, agentType, cwd };
    }) };
    const selected = vi.fn();
    const context = {
      agentType: "codex" as const,
      workspaceSource: "imported" as const,
      workspacePath: "/Users/test",
    };
    const createSession = (title: string, projectId?: string) => createSessionForWorkspace(api, title, { ...context, projectId });
    const sessionId = await prepareChatCommand({
      text: "first message", projectId: "imported:home", sessionId: null,
      createSession, activateSession: vi.fn(), showUserMessage: vi.fn(), onSessionCreated: selected,
    });
    expect(api.createSession).toHaveBeenCalledWith("first message", undefined, "codex", "/Users/test");
    expect(selected).toHaveBeenCalledWith(sessionId, { ...codexSession, cwd: "/Users/test" });

    await prepareChatCommand({
      text: "second message", projectId: "imported:home", sessionId,
      createSession, activateSession: vi.fn(), showUserMessage: vi.fn(), onSessionCreated: selected,
    });
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(selected).toHaveBeenCalledTimes(1);
  });

  it.each(["native", "derived"] as const)("preserves a %s runtime project identity", async workspaceSource => {
    const api = { createSession: vi.fn().mockResolvedValue(codexSession) };
    await createSessionForWorkspace(api, "hello", {
      projectId: "native-project", agentType: "codex", workspacePath: "/repo", workspaceSource,
    });
    expect(api.createSession).toHaveBeenCalledWith("hello", "native-project", "codex", "/repo");
  });

  it("keeps Customer Agent project routing and does not pass a native cwd", async () => {
    const api = { createSession: vi.fn().mockResolvedValue(codexSession) };
    await createSessionForWorkspace(api, "hello", { projectId: "ca-project", agentType: "customer-agent", workspacePath: "/repo" });
    expect(api.createSession).toHaveBeenCalledWith("hello", "ca-project", "customer-agent", undefined);
  });

  it("does not activate or display a message when creation is rejected", async () => {
    const api = { createSession: vi.fn().mockRejectedValue(new Error("creation unavailable")) };
    const activateSession = vi.fn();
    const showUserMessage = vi.fn();
    await expect(prepareChatCommand({
      text: "keep my draft", projectId: "imported:home", sessionId: null,
      createSession: title => createSessionForWorkspace(api, title, { agentType: "codex", workspaceSource: "imported", workspacePath: "/repo" }),
      activateSession, showUserMessage,
    })).rejects.toThrow("creation unavailable");
    expect(activateSession).not.toHaveBeenCalled();
    expect(showUserMessage).not.toHaveBeenCalled();
  });
});

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
