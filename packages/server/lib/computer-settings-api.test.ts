import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SQLiteAuthStore } from "../../core/src/infrastructure/SQLiteAuthStore";
import { SQLiteWebConsoleStore } from "../../core/src/infrastructure/SQLiteWebConsoleStore";
import { getDatabase } from "../../core/src/infrastructure/SQLiteDatabase";

const state = vi.hoisted(() => ({ store: null as SQLiteWebConsoleStore | null }));
vi.mock("@agent/core", async () => import("../../core/src/domain/web-console/computer-settings"));
vi.mock("./web-auth/anonymous", () => ({
  anonymousPrincipal: () => ({ userId: "owner" }),
  webConsoleStore: {
    getComputerSettings: (id: string) => state.store!.getComputerSettings(id),
    saveComputerSettings: (...args: Parameters<SQLiteWebConsoleStore["saveComputerSettings"]>) => state.store!.saveComputerSettings(...args),
  },
}));
import { GET, PATCH } from "../app/api/web-console/computer-settings/route";

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "computer-settings-api-"));
  const now = new Date().toISOString();
  new SQLiteAuthStore(base).createFirstUser({ id: "owner", usernameNormalized: "local", usernameDisplay: "local", passwordHash: Buffer.alloc(32), passwordSalt: Buffer.alloc(16), passwordVersion: 1, createdAt: now, passwordChangedAt: now });
  state.store = new SQLiteWebConsoleStore(base);
});
afterEach(() => { getDatabase(base).close(); rmSync(base, { recursive: true, force: true }); });
const patch = (body: unknown) => PATCH(new Request("http://computer/api/web-console/computer-settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const legacy = [{ id: "legacy", name: "旧页面", url: "https://example.com/", openMode: "current" }];

describe("computer settings API with SQLite", () => {
  it("returns fresh defaults dynamically and imports legacy pages once", async () => {
    const response = await GET();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).settings).toMatchObject({ revision: 0, visibleTools: ["refresh", "remote", "theme", "files"], savedPages: null });
    expect((await patch({ expectedRevision: 0, initializePages: legacy })).status).toBe(200);
    expect(state.store!.getComputerSettings("owner")?.savedPages).toEqual(legacy);
    expect((await patch({ expectedRevision: 1, savedPages: [] })).status).toBe(200);
    const retry = await patch({ expectedRevision: 0, initializePages: legacy });
    expect(retry.status).toBe(200);
    expect((await retry.json()).settings).toMatchObject({ revision: 2, savedPages: [] });
    expect(state.store!.getComputerSettings("owner")?.savedPages).toEqual([]);
  });
  it("retains pages when tools change, allows no tools, and rejects stale clients", async () => {
    await patch({ expectedRevision: 0, initializePages: legacy });
    expect((await patch({ expectedRevision: 1, visibleTools: [] })).status).toBe(200);
    expect(state.store!.getComputerSettings("owner")).toMatchObject({ revision: 2, visibleTools: [], savedPages: legacy });
    const stale = await patch({ expectedRevision: 1, savedPages: [] });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe("REVISION_CONFLICT");
    expect(state.store!.getComputerSettings("owner")?.savedPages).toEqual(legacy);
  });
  it("validates fields and binds writes to the workspace owner", async () => {
    for (const body of [null, [], { visibleTools: [] }, { expectedRevision: 0 }, { expectedRevision: 0, userId: "another-owner", visibleTools: [] }, { expectedRevision: 0, visibleTools: ["page"] }, { expectedRevision: 0, savedPages: [{ ...legacy[0], url: "javascript:alert(1)" }] }, { expectedRevision: 0, initializePages: [], savedPages: [] }]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(state.store!.getComputerSettings("owner")).toBeNull();
    expect(state.store!.getComputerSettings("another-owner")).toBeNull();
    expect((await PATCH(new Request("http://computer/api", { method: "PATCH", body: "{" }))).status).toBe(400);
  });
  it("reports a conflict when the storage compare-and-swap loses a race", async () => {
    const save = vi.spyOn(state.store!, "saveComputerSettings").mockReturnValueOnce(false);
    expect((await patch({ expectedRevision: 0, visibleTools: [] })).status).toBe(409);
    save.mockRestore();
    expect(state.store!.getComputerSettings("owner")).toBeNull();
  });
});
