import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostPathPolicy, SQLiteProjectStore } from "@agent/core";
import { WebProjectService } from "./web-project-service";

describe("WebProjectService", () => {
  it("returns the injected installation directory without listing the allowed root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-web-picker-"));
    const installation = join(root, ".agentroam");
    mkdirSync(installation);
    const paths = new HostPathPolicy([root]);
    const service = new WebProjectService({} as never, paths, installation);
    expect(service.pickerLocation()).toEqual({ roots: [realpathSync(root)], initialPath: realpathSync(installation) });
  });

  it("keeps project lifecycle behind injected ports", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-web-project-root-"));
    const data = mkdtempSync(join(tmpdir(), "agent-web-project-data-"));
    const projectPath = join(root, "customer-agent");
    mkdirSync(projectPath);
    const service = new WebProjectService(
      new SQLiteProjectStore(data),
      new HostPathPolicy([root]),
    );

    const created = await service.create(projectPath, "Customer Agent");
    const duplicate = await service.create(join(projectPath, "."), "Ignored");

    expect(duplicate.id).toBe(created.id);
    await expect(service.list()).resolves.toHaveLength(1);
    await expect(service.rename(created.id, "AgentRoam"))
      .resolves.toMatchObject({ name: "AgentRoam", description: realpathSync(projectPath) });
    expect(service.check(projectPath)).toBe(true);
    await service.delete(created.id);
    await expect(service.list()).resolves.toEqual([]);
  });

  it("rejects directories outside the path port boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-web-project-allowed-"));
    const outside = mkdtempSync(join(tmpdir(), "agent-web-project-outside-"));
    const data = mkdtempSync(join(tmpdir(), "agent-web-project-data-"));
    const service = new WebProjectService(
      new SQLiteProjectStore(data),
      new HostPathPolicy([root]),
    );

    await expect(service.create(outside)).rejects.toMatchObject({ code: "PATH_OUTSIDE_ROOT" });
    expect(service.check(outside)).toBe(false);
  });

  it("imports a user project separately from a collaboration member's internal project", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-web-project-group-"));
    const data = mkdtempSync(join(tmpdir(), "agent-web-project-data-"));
    const store = new SQLiteProjectStore(data);
    await store.create({id: "collaboration-internal", name: "群工作区", description: root, created: "2026-10-14", updated: "2026-10-14"});
    const project = await new WebProjectService(store, new HostPathPolicy([root])).create(root);
    expect(project.id).not.toBe("collaboration-internal");
    expect(project.description).toBe(realpathSync(root));
  });
});
