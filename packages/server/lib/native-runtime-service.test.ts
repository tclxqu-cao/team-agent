import { describe, expect, it } from "vitest";
import type {
  RuntimeHealth,
  UnifiedSessionSummary,
} from "../../desktop/main/agent-runtime/types.js";
import { encodeUnifiedSessionId } from "../../desktop/main/agent-runtime/session-id.js";
import type { NativeRuntimePort } from "./native-runtime-service";
import { NativeRuntimeService, normalizeProjectPath } from "./native-runtime-service";

function summary(
  id: string,
  updated = "2026-08-31T00:00:00.000Z",
  cwd = "/tmp",
): UnifiedSessionSummary {
  return {
    id,
    agentType: "codex",
    nativeSessionId: id,
    title: "新会话",
    cwd,
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
  forkResult: UnifiedSessionSummary | null = null;
  getError: unknown = null;
  listCalls: Array<string | undefined> = [];
  refreshCalls: Array<string | undefined> = [];

  health = async (): Promise<RuntimeHealth[]> => [];
  list = async (projectId?: string): Promise<UnifiedSessionSummary[]> => {
    this.listCalls.push(projectId);
    return projectId === undefined
      ? this.discovered
      : this.discovered.filter((session) => session.projectId === projectId);
  };
  refresh = async (projectId?: string): Promise<UnifiedSessionSummary[]> => {
    this.refreshCalls.push(projectId);
    return projectId === undefined
      ? this.discovered
      : this.discovered.filter((session) => session.projectId === projectId);
  };
  create = async (): Promise<UnifiedSessionSummary> => {
    if (!this.createResult) throw new Error("no create result configured");
    return this.createResult;
  };
  fork = async (): Promise<UnifiedSessionSummary> => {
    if (!this.forkResult) throw new Error("no fork result configured");
    return this.forkResult;
  };
  get = async (id: string) => {
    if (this.getError) throw this.getError;
    const found = this.discovered.find((s) => s.id === id);
    if (!found) throw new Error(`session not found: ${id}`);
    return { ...found, messages: [], events: [] };
  };
  getSessionWatchPath = async (id: string): Promise<string | null> => `/tmp/${id}.jsonl`;
  run = async function* (): AsyncGenerator<never> {};
  abort = async (): Promise<void> => {};
  answerQuestion = async (): Promise<boolean> => false;
}

describe("NativeRuntimeService", () => {
  it("keeps transcript watch paths internal while forwarding their lookup", async () => {
    const service = new NativeRuntimeService(new FakeRuntime());

    await expect(service.getSessionWatchPath("native-session")).resolves.toBe(
      "/tmp/native-session.jsonl",
    );
  });

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

  it("keeps forked sessions visible until the runtime discovers them", async () => {
    const runtime = new FakeRuntime();
    const sourceId = encodeUnifiedSessionId("codex", "source");
    runtime.forkResult = {
      ...summary(encodeUnifiedSessionId("codex", "fork"), "2026-08-31T12:00:00.000Z"),
      nativeSessionId: "fork",
    };
    const service = new NativeRuntimeService(runtime);

    const forked = await service.fork(sourceId);
    const listed = await service.list();

    expect(forked.id).toBe(runtime.forkResult.id);
    expect(listed.map((session) => session.id)).toEqual([runtime.forkResult.id]);
  });

  it("rejects Customer Agent session forks", async () => {
    const service = new NativeRuntimeService(new FakeRuntime());

    await expect(service.fork("ca-session")).rejects.toMatchObject({
      code: "OPERATION_NOT_SUPPORTED",
    });
  });

  it("uses the local project catalog before applying a project-scoped filter", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [summary("scoped", undefined, "/repo/app/packages/server")];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "root", description: "/repo" },
      { id: "app", description: "/repo/app" },
    ]);

    await expect(service.list("app")).resolves.toEqual([
      expect.objectContaining({ id: "scoped", projectId: "app" }),
    ]);
    expect(runtime.listCalls).toEqual([undefined]);
  });

  it("replaces foreign project IDs and excludes nonmatching local projects", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [{
      ...summary("foreign", undefined, "/repo/app"),
      projectId: "project-from-another-client",
    }];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "local-app", description: "/repo/app" },
      { id: "local-other", description: "/repo/other" },
    ]);

    await expect(service.list("local-app")).resolves.toEqual([
      expect.objectContaining({ id: "foreign", projectId: "local-app" }),
    ]);
    await expect(service.list("local-other")).resolves.toEqual([]);
  });

  it("associates Windows sessions across drive-letter and directory casing", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [summary("windows", undefined, "d:\\REPO\\packages\\app")];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "repo", description: "D:\\repo" },
    ], "win32");

    await expect(service.list("repo")).resolves.toEqual([
      expect.objectContaining({ id: "windows", projectId: "repo" }),
    ]);
  });

  it("keeps Windows project matching boundary-safe and selects the longest root", async () => {
    const runtime = new FakeRuntime();
    runtime.discovered = [
      summary("nested", undefined, "D:\\repo\\app\\src"),
      summary("prefix-only", undefined, "D:\\repo-old\\src"),
    ];
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "root", description: "D:\\repo" },
      { id: "app", description: "d:\\REPO\\app\\" },
    ], "win32");

    expect(await service.list("app")).toEqual([
      expect.objectContaining({ id: "nested", projectId: "app" }),
    ]);
    expect((await service.list()).find((session) => session.id === "prefix-only")?.projectId)
      .toBeUndefined();
  });

  it("keeps POSIX project matching case-sensitive", () => {
    expect(normalizeProjectPath("/Repo/App", "darwin"))
      .not.toBe(normalizeProjectPath("/repo/app", "darwin"));
  });

  it("keeps locally projected pending sessions visible in project-scoped listings", async () => {
    const runtime = new FakeRuntime();
    runtime.createResult = summary("fresh", "2026-08-31T12:00:00.000Z", "/repo/app");
    const service = new NativeRuntimeService(runtime, async () => [
      { id: "app", description: "/repo/app" },
    ]);
    await service.create({ agentType: "codex", title: "新会话", cwd: "/repo/app" });

    expect((await service.list("app")).map((session) => session.id)).toEqual(["fresh"]);

    runtime.discovered = [summary("fresh", "2026-08-31T12:05:00.000Z", "/repo/app")];
    const refreshed = await service.refresh("app");
    expect(refreshed.map((session) => session.id)).toEqual(["fresh"]);
    expect(refreshed[0].updated).toBe("2026-08-31T12:05:00.000Z");
    expect(runtime.refreshCalls).toEqual([undefined]);
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
