import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDatabase } from "@agent/core";

const ports = vi.hoisted(() => ({ directory: "", create: vi.fn(), remove: vi.fn(), importProject: vi.fn(), createCustomer: vi.fn(), removeCustomer: vi.fn() }));
vi.mock("./server-data-dir", () => ({ getServerBaseDir: () => ports.directory }));
vi.mock("./native-runtime-service", () => ({ getNativeRuntimeService: () => ({ create: ports.create, delete: ports.remove }) }));
vi.mock("../app/api/projects/project-http", () => ({ webProjectService: { create: ports.importProject } }));
vi.mock("../app/api/agent-host", () => ({ agentHost: { createSession: ports.createCustomer, getSessionStore: () => ({ delete: ports.removeCustomer }) } }));
import { createParallelSessionGroup, getParallelSessionGroup } from "./parallel-sessions";

describe("shared parallel-session application service", () => {
  beforeEach(() => {
    ports.directory = realpathSync(mkdtempSync(join(tmpdir(), "parallel-service-")));
    vi.stubEnv("AGENT_WEB_ROOTS", ports.directory);
    vi.clearAllMocks();
    ports.remove.mockResolvedValue(undefined);
    ports.create.mockImplementation(async input => ({
      id: `runtime:${input.agentType}:new`, nativeSessionId: "new", agentType: input.agentType, title: input.title, cwd: input.cwd,
      created: "now", updated: "now", status: "idle", occupancy: "available", sourceLabel: input.agentType, canResume: true, canDelete: true,
    }));
  });
  afterEach(() => { getDatabase(ports.directory).close(); rmSync(ports.directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

  it("creates unvisited native directories by cwd and persists lookup from either member", async () => {
    const group = await createParallelSessionGroup({ title: "question", cwd: ports.directory, agentTypes: ["codex", "zcode"] });
    expect(ports.create.mock.calls.map(call => call[0])).toEqual([
      { agentType: "codex", title: "question", cwd: ports.directory },
      { agentType: "zcode", title: "question", cwd: ports.directory },
    ]);
    expect(ports.importProject).not.toHaveBeenCalled();
    expect(getParallelSessionGroup(group.members[1].id)).toEqual(group);
  });

  it("imports a Customer Agent workspace separately while keeping the native project identity independent", async () => {
    ports.importProject.mockResolvedValue({ id: "customer-project" });
    ports.createCustomer.mockResolvedValue({ id: "customer-session", title: "question", created: "now", updated: "now" });
    const group = await createParallelSessionGroup({ title: "question", cwd: ports.directory, agentTypes: ["customer-agent", "zcode"] });
    expect(ports.importProject).toHaveBeenCalledWith(ports.directory);
    expect(ports.createCustomer).toHaveBeenCalledWith("question", "customer-project");
    expect(ports.create).toHaveBeenCalledWith({ agentType: "zcode", title: "question", cwd: ports.directory });
    expect(group.members[0]).toMatchObject({ projectId: "customer-project", messageQueueVersion: 1 });
  });

  it("does not persist an incomplete association after one Agent fails to create", async () => {
    ports.create.mockImplementation(async input => { if (input.agentType === "zcode") throw new Error("unavailable"); return { id: "runtime:codex:created-empty", agentType: input.agentType }; });
    await expect(createParallelSessionGroup({ title: "question", cwd: ports.directory, agentTypes: ["codex", "zcode"] })).rejects.toThrow("unavailable");
    expect(ports.remove).toHaveBeenCalledWith("runtime:codex:created-empty");
    expect(getParallelSessionGroup("runtime:codex:created-empty")).toBeNull();
  });
});
