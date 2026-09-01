import { describe, expect, it } from "vitest";
import type {
  RuntimeHealth,
  UnifiedSessionSummary,
} from "../../desktop/main/agent-runtime/types.js";
import type { NativeRuntimePort } from "./native-runtime-service";
import { NativeRuntimeService } from "./native-runtime-service";

function summary(id: string, updated = "2026-08-31T00:00:00.000Z"): UnifiedSessionSummary {
  return {
    id,
    agentType: "codex",
    nativeSessionId: id,
    title: "新会话",
    cwd: "/tmp",
    created: updated,
    updated,
    status: "idle",
    occupancy: "available",
    sourceLabel: "Codex",
    canResume: true,
    canDelete: false,
  };
}

class FakeRuntime implements NativeRuntimePort {
  discovered: UnifiedSessionSummary[] = [];
  createResult: UnifiedSessionSummary | null = null;
  getError: unknown = null;

  health = async (): Promise<RuntimeHealth[]> => [];
  list = async (projectId?: string): Promise<UnifiedSessionSummary[]> =>
    projectId === undefined ? this.discovered : this.discovered.filter((s) => s.projectId === projectId);
  refresh = async (projectId?: string): Promise<UnifiedSessionSummary[]> => this.list(projectId);
  create = async (): Promise<UnifiedSessionSummary> => {
    if (!this.createResult) throw new Error("no create result configured");
    return this.createResult;
  };
  get = async (id: string) => {
    if (this.getError) throw this.getError;
    const found = this.discovered.find((s) => s.id === id);
    if (!found) throw new Error(`session not found: ${id}`);
    return { ...found, messages: [], events: [] };
  };
  run = async function* (): AsyncGenerator<never> {};
  abort = async (): Promise<void> => {};
  answerQuestion = async (): Promise<boolean> => false;
}

describe("NativeRuntimeService", () => {
  it("keeps created sessions visible until the runtime discovers them", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [summary("old", "2026-08-30T00:00:00.000Z")];
    runtime.createResult = summary("fresh", "2026-08-31T12:00:00.000Z");
    const service = new NativeRuntimeService(runtime);

    const created = await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });
    const listed = await service.list();

    expect(created.id).toBe("fresh");
    expect(listed.map((s) => s.id)).toEqual(["fresh", "old"]);
  });

  it("drops pending entries once discovery returns them", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh");
    const service = new NativeRuntimeService(runtime);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });

    runtime.discovered = [summary("fresh", "2026-08-31T12:05:00.000Z")];
    const listed = await service.refresh();

    expect(listed.map((s) => s.id)).toEqual(["fresh"]);
    expect(listed[0].updated).toBe("2026-08-31T12:05:00.000Z");
  });

  it("never merges pending sessions into project-scoped listings", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh", "2026-08-31T12:00:00.000Z");
    runtime.discovered = [{ ...summary("scoped"), projectId: "p1" }];
    const service = new NativeRuntimeService(runtime);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });

    expect((await service.list("p1")).map((s) => s.id)).toEqual(["scoped"]);
    expect((await service.list()).map((s) => s.id)).toEqual(["fresh", "scoped"]);
  });

  it("serves detail from the pending registry when lookup fails", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh");
    const service = new NativeRuntimeService(runtime);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/tmp" });

    const detail = await service.get("fresh");
    expect(detail.id).toBe("fresh");
    expect(detail.messages).toEqual([]);
  });

  it("propagates lookup errors for sessions it never created", async () => {
    const runtime = new FakeRuntime();
    const service = new NativeRuntimeService(runtime);
    await expect(service.get("unknown")).rejects.toThrow("session not found");
  });
});
