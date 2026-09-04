import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UnifiedSessionSummary } from "../global";
import {
  canForkOccupiedCodexSession,
  forkOccupiedCodexSession,
  isOccupiedSessionRecovery,
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
  it("allows only occupied Codex sessions or Codex sessions rejected as occupied", () => {
    const sourceError = {
      sessionId: "runtime:codex:c291cmNl",
      code: "SESSION_OCCUPIED",
    };
    expect(canForkOccupiedCodexSession(summary())).toBe(true);
    expect(canForkOccupiedCodexSession(summary({ agentType: "opencode" }))).toBe(true);
    expect(canForkOccupiedCodexSession(summary({ occupancy: "available" }), sourceError)).toBe(true);
    expect(canForkOccupiedCodexSession(summary({ agentType: "claude-code" }))).toBe(false);
    expect(canForkOccupiedCodexSession(summary({ occupancy: "available" }))).toBe(false);
    expect(canForkOccupiedCodexSession(undefined, sourceError)).toBe(false);
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
      refreshAndSelect: async (id) => {
        calls.push(`select:${id}`);
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

    expect(source).toContain("SESSION_OCCUPIED");
    expect(source).toContain("forkSession: (id) => window.agentApi!.forkSession(id)");
    expect(source).toContain("以副本继续");
    expect(source).toContain("正在创建…");
    expect(source).toContain("setInput(occupiedDraft)");
    expect(source).toContain("loadSessionWithRetry");
    expect(source).toContain("limit: SESSION_HISTORY_PAGE_SIZE");
    expect(source).toContain("setSessionReloadGeneration((generation) => generation + 1)");
    expect(source).toContain("重新加载会话");
  });

  it("keeps the Electron fork transport contract", () => {
    const main = readFileSync(resolve(process.cwd(), "packages/desktop/main/index.ts"), "utf8");
    const preload = readFileSync(resolve(process.cwd(), "packages/desktop/main/preload.ts"), "utf8");
    const globalTypes = readFileSync(resolve(
      process.cwd(),
      "packages/desktop/renderer/global.d.ts",
    ), "utf8");

    expect(main).toContain('ipcMain.handle("sessions:fork"');
    expect(preload).toContain('forkSession: (id: string) => ipcRenderer.invoke("sessions:fork", id)');
    expect(globalTypes).toContain("forkSession(id: string): Promise<UnifiedSessionSummary>");
  });
});
