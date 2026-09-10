import { describe, expect, it, vi } from "vitest";
import { createSessionPermissionGate, newSessionMetadata, setSessionPermissionMode, type AgentSessionPolicyStore } from "./SessionPermission.js";
import type { Session } from "./entities.js";

function fakeStore(session: Session | null): AgentSessionPolicyStore & { updates: Array<Partial<Session>> } {
  const updates: Array<Partial<Session>> = [];
  return {
    updates,
    async get(id: string) { return session && id === session.id ? session : null; },
    async update(_id, update) {
      updates.push(update);
      return { ...session!, ...update } as Session;
    },
  };
}

function makeSession(metadata: Record<string, unknown>): Session {
  return {
    id: "s1",
    projectId: "",
    title: "t",
    status: "idle",
    messages: [],
    events: [],
    created: "",
    updated: "",
    metadata,
  } as Session;
}

describe("setSessionPermissionMode", () => {
  it("persists the mode and clears pending approvals for the session", async () => {
    const session = makeSession({ permissionMode: "full-access" });
    const store = fakeStore(session);
    const gate = createSessionPermissionGate({ sessionStore: store, requestApproval: async () => "deny" as const });
    const clearSpy = vi.spyOn(gate, "clearSession");
    const updated = await setSessionPermissionMode(store, gate, "s1", "request-approval");
    expect(updated.metadata.permissionMode).toBe("request-approval");
    expect(store.updates[0].metadata).toMatchObject({ permissionMode: "request-approval" });
    expect(clearSpy).toHaveBeenCalledWith("s1");
  });

  it("rejects an unknown mode without touching the store", async () => {
    const store = fakeStore(makeSession({}));
    const gate = createSessionPermissionGate({ sessionStore: store, requestApproval: async () => "deny" as const });
    await expect(setSessionPermissionMode(store, gate, "s1", "chaos" as never)).rejects.toThrow("Invalid permission mode");
    await expect(setSessionPermissionMode(store, gate, "missing", "request-approval")).rejects.toThrow("Session not found");
    expect(store.updates).toHaveLength(0);
  });
});

describe("createSessionPermissionGate resolveMode", () => {
  it("falls back to the normalized default when the session has no mode", async () => {
    const store = fakeStore(makeSession({}));
    const gate = createSessionPermissionGate({ sessionStore: store, requestApproval: async () => "deny" as const });
    // @ts-expect-error reaching into private options is test-only
    expect(await gate.options.resolveMode("s1")).toBeDefined();
  });
});

describe("newSessionMetadata", () => {
  it("bootstraps full-access with pending auto-title only for placeholder titles", () => {
    expect(newSessionMetadata("新会话")).toMatchObject({ permissionMode: "full-access", autoTitleFromFirstMessage: true });
    expect(newSessionMetadata("我的会话")).toMatchObject({ permissionMode: "full-access" });
    expect(newSessionMetadata("我的会话").autoTitleFromFirstMessage).toBeUndefined();
  });
});
