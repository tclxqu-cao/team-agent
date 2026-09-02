import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HostPathPolicy, SQLiteProjectStore } from "@agent/core";
import { WebProjectService } from "./web-project-service";

describe("WebProjectService", () => {
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
});
