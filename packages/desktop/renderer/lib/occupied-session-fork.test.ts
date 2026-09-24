import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "../global";
import {
  canForkOccupiedCodexSession,
  clearOccupiedRecovery,
  createOccupiedSessionRecovery,
  findOccupiedRecovery,
  forkOccupiedCodexSession,
  isOccupiedSessionRecovery,
  isOccupiedRecoveryVisible,
  markOccupiedRecoveryForked,
  occupiedRecoveryMessageId,
  storeOccupiedRecovery,
} from "./occupied-session-fork";

function summary(overrides: Partial<UnifiedSessionSummary> = {}): UnifiedSessionSummary {
  return {
    id: "runtime:codex:c291cmNl",
    agentType: "codex",
    nativeSessionId: "source",
    title: "原会话",
    cwd: "/tmp/project",
    created: "2026-09-01T00:00:00.000Z",
    updated: "2026-09-01T00:00:00.000Z",
    status: "idle",
    occupancy: "owned-externally",
    sourceLabel: "Codex",
    canResume: false,
    canDelete: false,
    ...overrides,
  };
}

describe("occupied Codex session fork recovery", () => {
  it("allows recovery only after the selected native session is rejected as occupied", () => {
    const sourceError = {
      sessionId: "runtime:codex:c291cmNl",
      code: "SESSION_OCCUPIED",
    };
    expect(canForkOccupiedCodexSession(summary())).toBe(false);
    expect(canForkOccupiedCodexSession(summary(), sourceError)).toBe(true);
    expect(canForkOccupiedCodexSession(summary({ agentType: "opencode" }), sourceError)).toBe(true);
    expect(canForkOccupiedCodexSession(summary({ occupancy: "available" }), sourceError)).toBe(true);
    expect(canForkOccupiedCodexSession(summary({ agentType: "claude-code" }))).toBe(false);
    expect(canForkOccupiedCodexSession(summary({ occupancy: "available" }))).toBe(false);
    expect(canForkOccupiedCodexSession(undefined, sourceError)).toBe(false);
  });

  it("preserves the send payload and reuses one fork for retries", () => {
    const recovery = createOccupiedSessionRecovery(
      summary().id,
      {
        content: "continue",
        images: ["image"],
        agentIds: ["agent-1"],
        restoreDraftOnFailure: false,
      },
      "recovery-1",
    );
    const forked = markOccupiedRecoveryForked(recovery, "runtime:codex:Zm9yaw");

    expect(forked).toMatchObject({
      token: "recovery-1",
      sourceSessionId: summary().id,
      forkSessionId: "runtime:codex:Zm9yaw",
      sendAttempted: true,
      payload: {
        content: "continue",
        images: ["image"],
        agentIds: ["agent-1"],
        restoreDraftOnFailure: false,
      },
    });
    expect(markOccupiedRecoveryForked(forked, forked.forkSessionId!)).toBe(forked);
    expect(occupiedRecoveryMessageId(forked)).toBe("occupied-recovery:recovery-1");
    expect(isOccupiedRecoveryVisible(forked, forked.sourceSessionId)).toBe(true);
    expect(isOccupiedRecoveryVisible(forked, forked.forkSessionId)).toBe(true);
  });

  it("keeps recoveries isolated by source and fork session", () => {
    const first = createOccupiedSessionRecovery(
      "runtime:codex:c291cmNl",
      { content: "first" },
      "recovery-1",
    );
    const second = createOccupiedSessionRecovery(
      "runtime:codex:c2Vjb25k",
      { content: "second" },
      "recovery-2",
    );
    let recoveries = storeOccupiedRecovery({}, first);
    recoveries = storeOccupiedRecovery(recoveries, second);

    expect(findOccupiedRecovery(recoveries, first.sourceSessionId)).toBe(first);
    expect(findOccupiedRecovery(recoveries, second.sourceSessionId)).toBe(second);

    const forked = markOccupiedRecoveryForked(first, "runtime:codex:Zm9yaw");
    recoveries = storeOccupiedRecovery(recoveries, forked);
    expect(findOccupiedRecovery(recoveries, forked.forkSessionId)).toBe(forked);

    recoveries = clearOccupiedRecovery(recoveries, forked.forkSessionId!);
    expect(findOccupiedRecovery(recoveries, first.sourceSessionId)).toBeUndefined();
    expect(findOccupiedRecovery(recoveries, second.sourceSessionId)).toBe(second);
  });

  it("does not carry the source recovery state into the selected fork", () => {
    const sourceError = {
      sessionId: "runtime:codex:c291cmNl",
      code: "SESSION_OCCUPIED",
    };
    const forked = summary({
      id: "runtime:codex:Zm9yaw",
      nativeSessionId: "fork",
      title: "原会话（副本）",
      occupancy: "available",
      canResume: true,
    });

    expect(isOccupiedSessionRecovery(summary().id, sourceError)).toBe(true);
    expect(isOccupiedSessionRecovery(forked.id, sourceError)).toBe(false);
    expect(canForkOccupiedCodexSession(forked, sourceError)).toBe(false);
  });

  it("activates and refreshes only after the fork succeeds", async () => {
    const calls: string[] = [];
    const forked = summary({
      id: "runtime:codex:Zm9yaw",
      nativeSessionId: "fork",
      title: "原会话（副本）",
      occupancy: "owned-by-customer-agent",
      canResume: true,
    });

    await expect(forkOccupiedCodexSession({
      sourceSessionId: "runtime:codex:c291cmNl",
      forkSession: async (id) => {
        calls.push(`fork:${id}`);
        return forked;
      },
      activateSession: (id) => calls.push(`activate:${id}`),
      refreshAndSelect: async (session) => {
        calls.push(`select:${session.id}`);
      },
    })).resolves.toEqual(forked);

    expect(calls).toEqual([
      "fork:runtime:codex:c291cmNl",
      "activate:runtime:codex:Zm9yaw",
      "select:runtime:codex:Zm9yaw",
    ]);
  });

  it("leaves activation untouched when forking fails", async () => {
    const activateSession = vi.fn();
    const refreshAndSelect = vi.fn();

    await expect(forkOccupiedCodexSession({
      sourceSessionId: "runtime:codex:c291cmNl",
      forkSession: async () => { throw new Error("fork failed"); },
      activateSession,
      refreshAndSelect,
    })).rejects.toThrow("fork failed");

    expect(activateSession).not.toHaveBeenCalled();
    expect(refreshAndSelect).not.toHaveBeenCalled();
  });

  it("keeps the shared ChatView recovery contract", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "packages/desktop/renderer/components/ChatView.tsx",
    ), "utf8");
    const forkHandler = source.slice(
      source.indexOf("const handleForkOccupiedSession = async () =>"),
      source.indexOf("const handleAbort = () =>"),
    );
    const restoreToComposer = source.slice(
      source.indexOf("const restoreForkRecoveryToComposer = ("),
      source.indexOf("const handleEvent = (event: StreamEvent)"),
    );

    expect(source).toContain("SESSION_OCCUPIED");
    expect(source).toContain('event.code === "SESSION_ALREADY_RUNNING"');
    expect(source).toContain("findLatestUnqueuedUserMessageId");
    expect(source).toContain("isQueued: true");
    expect(source).toContain("shouldQueueMessageForActiveRun");
    expect(source).toContain("forkSession: (id) => window.agentApi!.forkSession(id)");
    expect(source).toContain("onSessionCreated(forked.id, forked)");
    expect(source).toContain("以副本继续");
    expect(source).toContain("正在创建…");
    expect(source).toContain("setInput(recoveryPayload.content)");
    expect(source).toContain("pendingNativeSendPayloadRef.current.set")
    expect(source).toContain("startRun(nextRecovery.payload, forked.id");
    expect(source).toContain("existingRecovery ?? createOccupiedSessionRecovery");
    expect(source).toContain("commitOccupiedRecovery(nextRecovery)");
    expect(source).toContain("occupiedRecoveryMessageId(targetRecovery)");
    expect(forkHandler).toContain('sendState: "pending"');
    expect(forkHandler).toContain('({ ...message, sendState: "pending" })');
    expect(source).toContain("const showOccupiedRecoveryBanner = isOccupiedRecovery");
    expect(source).toContain("occupiedRecovery?.forkSessionId !== viewSessionId");
    expect(source).toContain("{showOccupiedRecoveryBanner && (");
    expect(restoreToComposer).toContain("sessionMessages.filter((message) => message.id !== messageId)");
    expect(restoreToComposer).toContain("setInput(recovery.payload.content)");
    expect(restoreToComposer).toContain("setPendingImages(recovery.payload.images ?? [])");
    expect(restoreToComposer).toContain("commitOccupiedRecovery(undefined, targetSessionId)");
    expect(source.match(/restoreForkRecoveryToComposer\(eventSid, forkRecovery\)/g)).toHaveLength(2);
    expect(source).toContain("restoreForkRecoveryToComposer(targetSessionId, recovery)");
    expect(source).toContain('sessionSummary.agentType !== "codex"');
    expect(source).toContain("loadSessionWithRetry");
    expect(source).toContain("CODEX_LATEST_HISTORY_PAGE_SIZE = 1");
    expect(source).toContain('? CODEX_LATEST_HISTORY_PAGE_SIZE\n                : SESSION_HISTORY_PAGE_SIZE');
    expect(source).toContain("setSessionReloadGeneration((generation) => generation + 1)");
    expect(source).toContain("重新加载会话");
  });

  it("keeps the shared-service fork transport contract", () => {
    const sharedService = readFileSync(resolve(
      process.cwd(),
      "packages/desktop/renderer/lib/shared-service.ts",
    ), "utf8");
    const gateway = readFileSync(resolve(
      process.cwd(),
      "packages/webapp/src/infrastructure/http/agent-http-gateway.ts",
    ), "utf8");
    const globalTypes = readFileSync(resolve(
      process.cwd(),
      "packages/desktop/renderer/global.d.ts",
    ), "utf8");

    expect(sharedService).toContain("const gateway = new AgentHttpGateway");
    expect(gateway).toContain("async forkSession(id: string)");
    expect(gateway).toContain("`/api/sessions/${encodeURIComponent(id)}/fork`");
    expect(globalTypes).toContain("forkSession(id: string): Promise<UnifiedSessionSummary>");
  });
});
